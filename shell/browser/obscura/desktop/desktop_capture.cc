// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "desktop_capture.h"
#include "display.h"
#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <X11/Xatom.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

namespace weber::desktop {
using Json = nlohmann::json;
namespace {
constexpr size_t kMaxSources = 256;
constexpr unsigned long kMaxWindowCandidates = 4096;
constexpr size_t kMaxImagePixels = 16000000;
constexpr size_t kMaxEncodedBytes = 8 * 1024 * 1024;
constexpr int kMaxThumbnailDimension = 1024;
struct Unref { template<class T> void operator()(T* p) const { if (p) g_object_unref(p); } };
template<class T> using GObjectPtr = std::unique_ptr<T, Unref>;
struct FreeX { void operator()(void* p) const { if (p) XFree(p); } };
struct FreeG { void operator()(void* p) const { g_free(p); } };

// Windows may disappear between enumeration, metadata lookup and capture.
// Never allow an asynchronous BadWindow/BadDrawable to terminate the host.
class XErrors {
 public:
  explicit XErrors(GdkDisplay* display) : display_(display) { gdk_x11_display_error_trap_push(display_); }
  ~XErrors() { if (active_) gdk_x11_display_error_trap_pop_ignored(display_); }
  bool Failed() { active_ = false; return gdk_x11_display_error_trap_pop(display_) != 0; }
 private:
  GdkDisplay* display_;
  bool active_ = true;
};
struct Property {
  std::unique_ptr<unsigned char, FreeX> data;
  Atom type = None;
  int format = 0;
  unsigned long count = 0, remaining = 0;
};
Property GetProperty(GdkDisplay* gdk, Window window, const char* name, Atom type,
                     long max_words) {
  auto* display = gdk_x11_display_get_xdisplay(gdk);
  const Atom atom = XInternAtom(display, name, True);
  if (atom == None) return {};
  Property result;
  unsigned char* bytes = nullptr;
  XErrors errors(gdk);
  const int status = XGetWindowProperty(display, window, atom, 0, max_words, False,
    type, &result.type, &result.format, &result.count, &result.remaining, &bytes);
  result.data.reset(bytes);
  if (errors.Failed() || status != Success || (type != AnyPropertyType && result.type != type)) return {};
  return result;
}
Json EmptyImage() { return {{"data", ""}, {"size", {{"width", 0}, {"height", 0}}}}; }

Json EncodeImage(GdkPixbuf* original, int max_width, int max_height, size_t& budget) {
  if (!original || !max_width || !max_height) return EmptyImage();
  const int width = gdk_pixbuf_get_width(original), height = gdk_pixbuf_get_height(original);
  const double scale = std::min({1.0, double(max_width) / width, double(max_height) / height});
  const int target_width = std::max(1, static_cast<int>(std::floor(width * scale)));
  const int target_height = std::max(1, static_cast<int>(std::floor(height * scale)));
  GObjectPtr<GdkPixbuf> scaled;
  if (width != target_width || height != target_height) {
    scaled.reset(gdk_pixbuf_scale_simple(original, target_width, target_height, GDK_INTERP_BILINEAR));
    if (!scaled) throw std::runtime_error("Desktop thumbnail allocation failed");
    original = scaled.get();
  }
  gchar* png = nullptr;
  gsize length = 0;
  GError* error = nullptr;
  const bool saved = gdk_pixbuf_save_to_buffer(original, &png, &length, "png", &error,
    "compression", "1", nullptr);
  std::unique_ptr<gchar, FreeG> owned_png(png);
  if (!saved) {
    const std::string reason = error ? error->message : "unknown encoder error";
    if (error) g_error_free(error);
    throw std::runtime_error("Desktop PNG encoding failed: " + reason);
  }
  if (error) g_error_free(error);
  const size_t encoded_size = ((length + 2) / 3) * 4;
  if (encoded_size > budget) throw std::runtime_error("Desktop capture images exceed the 8 MiB response budget");
  budget -= encoded_size;
  std::unique_ptr<gchar, FreeG> encoded(g_base64_encode(reinterpret_cast<const guchar*>(png), length));
  if (!encoded) throw std::runtime_error("Desktop PNG base64 allocation failed");
  return {{"data", encoded.get()}, {"size", {{"width", target_width}, {"height", target_height}}}};
}

GObjectPtr<GdkPixbuf> Capture(GdkDisplay* gdk, GdkWindow* window, int x, int y, int width, int height) {
  if (!window || width <= 0 || height <= 0) return {};
  const int scale = std::max(1, gdk_window_get_scale_factor(window));
  if (width > 16384 || height > 16384 || uint64_t(width) * height * scale * scale > kMaxImagePixels)
    throw std::runtime_error("Desktop capture surface exceeds the 16 megapixel limit");
  XErrors errors(gdk);
  GObjectPtr<GdkPixbuf> image(gdk_pixbuf_get_from_window(window, x, y, width, height));
  if (errors.Failed()) return {};
  return image;
}

std::string WindowName(GdkDisplay* gdk, Window window) {
  auto* display = gdk_x11_display_get_xdisplay(gdk);
  const auto utf8 = XInternAtom(display, "UTF8_STRING", False);
  auto property = GetProperty(gdk, window, "_NET_WM_NAME", utf8, 2048);
  if (!property.data || property.format != 8 || !property.count)
    property = GetProperty(gdk, window, "WM_NAME", AnyPropertyType, 2048);
  if (!property.data || property.format != 8 || !property.count) return {};
  const auto* bytes = reinterpret_cast<const gchar*>(property.data.get());
  // JSON must remain valid even when an old X11 client publishes a legacy title.
  std::unique_ptr<gchar, FreeG> name(property.type == XA_STRING
    ? g_convert(bytes, property.count, "UTF-8", "ISO-8859-1", nullptr, nullptr, nullptr)
    : g_utf8_make_valid(bytes, property.count));
  return name ? std::string(name.get()) : std::string();
}

bool IsApplicationWindow(GdkDisplay* gdk, Window window) {
  auto property = GetProperty(gdk, window, "_NET_WM_WINDOW_TYPE", XA_ATOM, 32);
  if (!property.data || property.format != 32) return true;
  auto* display = gdk_x11_display_get_xdisplay(gdk);
  const Atom desktop = XInternAtom(display, "_NET_WM_WINDOW_TYPE_DESKTOP", True);
  const Atom dock = XInternAtom(display, "_NET_WM_WINDOW_TYPE_DOCK", True);
  const auto* types = reinterpret_cast<const unsigned long*>(property.data.get());
  for (unsigned long i = 0; i < property.count; ++i)
    if (types[i] == desktop || types[i] == dock) return false;
  return true;
}

std::vector<Window> WindowCandidates(GdkDisplay* gdk, Window root, bool& managed) {
  for (const char* key : {"_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST"}) {
    auto property = GetProperty(gdk, root, key, XA_WINDOW, kMaxWindowCandidates);
    if (property.type != XA_WINDOW || property.format != 32) continue;
    if (property.remaining) throw std::runtime_error("Desktop window candidate count exceeds bounds");
    managed = true;
    const auto* windows = reinterpret_cast<const unsigned long*>(property.data.get());
    if (!property.count) return {};
    return {windows, windows + property.count};
  }
  // Xvfb and desktops without an EWMH window manager still have real top-level
  // windows. Do not invent a source when the root tree is empty.
  Window parent = None, actual_root = None, *children = nullptr;
  unsigned int count = 0;
  XErrors errors(gdk);
  const bool ok = XQueryTree(gdk_x11_display_get_xdisplay(gdk), root, &actual_root, &parent, &children, &count);
  std::unique_ptr<Window, FreeX> owned_children(children);
  if (errors.Failed() || !ok) throw std::runtime_error("Cannot enumerate X11 desktop windows");
  if (count > kMaxWindowCandidates) throw std::runtime_error("Desktop window candidate count exceeds bounds");
  managed = false;
  if (!count) return {};
  return {children, children + count};
}

Json WindowIcon(GdkDisplay* gdk, Window window, size_t& budget) {
  // _NET_WM_ICON is a bounded sequence of width, height, ARGB32 pixels. Xlib
  // expands format-32 values to unsigned long, including on 64-bit systems.
  auto property = GetProperty(gdk, window, "_NET_WM_ICON", XA_CARDINAL, 1024 * 1024 + 2);
  if (!property.data || property.format != 32 || property.remaining) return nullptr;
  const auto* values = reinterpret_cast<const unsigned long*>(property.data.get());
  size_t offset = 0, best_offset = 0;
  unsigned long best_width = 0, best_height = 0;
  int best_distance = std::numeric_limits<int>::max();
  while (offset + 2 <= property.count) {
    const auto width = values[offset++], height = values[offset++];
    if (!width || !height || width > 1024 || height > 1024 || width * height > property.count - offset) return nullptr;
    const int distance = std::abs(static_cast<int>(std::max(width, height)) - 64);
    if (distance < best_distance) {
      best_distance = distance; best_offset = offset; best_width = width; best_height = height;
    }
    offset += width * height;
  }
  if (!best_width || offset != property.count) return nullptr;
  GObjectPtr<GdkPixbuf> icon(gdk_pixbuf_new(GDK_COLORSPACE_RGB, TRUE, 8, best_width, best_height));
  if (!icon) throw std::runtime_error("Desktop icon allocation failed");
  auto* pixels = gdk_pixbuf_get_pixels(icon.get());
  const auto stride = gdk_pixbuf_get_rowstride(icon.get());
  for (unsigned long y = 0; y < best_height; ++y) for (unsigned long x = 0; x < best_width; ++x) {
    const auto argb = values[best_offset + y * best_width + x];
    auto* pixel = pixels + y * stride + x * 4;
    pixel[0] = (argb >> 16) & 255; pixel[1] = (argb >> 8) & 255;
    pixel[2] = argb & 255; pixel[3] = (argb >> 24) & 255;
  }
  return EncodeImage(icon.get(), 64, 64, budget);
}

int Dimension(const Json& size, const char* key) {
  const auto& value = size.at(key);
  if (!value.is_number_integer() || value < 0 || value > kMaxThumbnailDimension)
    throw std::runtime_error("Desktop thumbnail dimensions must be integers between 0 and 1024");
  return value.get<int>();
}
}

Json DesktopCaptureSources(const Json& request) {
  auto* gdk = gdk_display_get_default();
  if (!gdk || !GDK_IS_X11_DISPLAY(gdk))
    throw std::runtime_error("Desktop source capture currently requires an X11 display; Wayland portal capture is not implemented");
  const bool capture_window = request.value("captureWindow", false);
  const bool capture_screen = request.value("captureScreen", false);
  const bool fetch_icons = request.value("fetchWindowIcons", false);
  const auto size = request.value("thumbnailSize", Json{{"width", 150}, {"height", 150}});
  const int width = Dimension(size, "width"), height = Dimension(size, "height");
  Json sources = Json::array();
  size_t image_budget = kMaxEncodedBytes;
  auto append = [&](Json source) {
    if (sources.size() >= kMaxSources) throw std::runtime_error("Desktop source count exceeds the 256 source limit");
    sources.push_back(std::move(source));
  };
  auto* display = gdk_x11_display_get_xdisplay(gdk);
  if (capture_window) {
    bool managed = false;
    auto candidates = WindowCandidates(gdk, DefaultRootWindow(display), managed);
    std::unordered_set<Window> seen;
    for (const auto xid : candidates) {
      if (xid == None || !seen.insert(xid).second) continue;
      XWindowAttributes attributes{};
      XErrors errors(gdk);
      const bool ok = XGetWindowAttributes(display, xid, &attributes);
      if (errors.Failed() || !ok || attributes.c_class != InputOutput || attributes.override_redirect ||
          (!managed && attributes.map_state != IsViewable)) continue;
      if (!IsApplicationWindow(gdk, xid)) continue;
      const auto name = WindowName(gdk, xid);
      if (name.empty()) continue;
      if (sources.size() >= kMaxSources) throw std::runtime_error("Desktop source count exceeds the 256 source limit");
      Json thumbnail = EmptyImage();
      if (width && height && attributes.map_state == IsViewable) {
        XErrors capture_errors(gdk);
        GObjectPtr<GdkPixbuf> image;
        {
          GObjectPtr<GdkWindow> window(gdk_x11_window_foreign_new_for_display(gdk, xid));
          if (window) {
            // GDK/XGetImage reads the visible drawable. Unmapped windows have an
            // empty thumbnail; obscured pixels are not guaranteed without XComposite.
            image = Capture(gdk, window.get(), 0, 0, gdk_window_get_width(window.get()), gdk_window_get_height(window.get()));
          }
        }
        // Keep the error trap installed while the foreign GdkWindow reference
        // is released too: the X11 window may disappear during that cleanup.
        if (!capture_errors.Failed()) thumbnail = EncodeImage(image.get(), width, height, image_budget);
      }
      append({{"id", "window:" + std::to_string(xid) + ":0"}, {"name", name}, {"display_id", ""},
        {"thumbnail", std::move(thumbnail)}, {"appIcon", fetch_icons ? WindowIcon(gdk, xid, image_budget) : Json(nullptr)}});
    }
  }
  if (capture_screen) {
    // DisplayCommand assigns stable IDs to the same live GdkMonitor objects
    // used by screen.getAllDisplays(), even if capture is called first.
    const auto displays = DisplayCommand({{"method", "screen.displays"}});
    auto* root = gdk_get_default_root_window();
    for (size_t i = 0; i < displays.size(); ++i) {
      const auto& monitor = displays[i];
      const auto& bounds = monitor.at("bounds");
      Json thumbnail = EmptyImage();
      if (width && height) {
        auto image = Capture(gdk, root, bounds.at("x").get<int>(), bounds.at("y").get<int>(),
          bounds.at("width").get<int>(), bounds.at("height").get<int>());
        thumbnail = EncodeImage(image.get(), width, height, image_budget);
      }
      append({{"id", "screen:" + std::to_string(i) + ":0"}, {"name", displays.size() == 1 ? "Entire Screen" : "Screen " + std::to_string(i + 1)},
        {"display_id", std::to_string(monitor.at("id").get<uint64_t>())}, {"thumbnail", std::move(thumbnail)}, {"appIcon", nullptr}});
    }
  }
  return sources;
}
}

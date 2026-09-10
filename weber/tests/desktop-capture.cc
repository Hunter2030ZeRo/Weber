// Copyright Weber contributors. SPDX-License-Identifier: MIT
// Run only on a dedicated Xvfb display: this fixture owns root EWMH properties.
#include "../../shell/browser/obscura/desktop/desktop_capture.h"
#include "../../shell/browser/obscura/desktop/display.h"
#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <X11/Xatom.h>
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using Json = nlohmann::json;
using weber::desktop::DesktopCaptureSources;
void Check(bool ok, const char* reason) { if (!ok) throw std::runtime_error(reason); }
const Json& Source(const Json& sources, const std::string& id) {
  for (const auto& source : sources) if (source.at("id") == id) return source;
  throw std::runtime_error("Expected desktop source missing: " + id);
}
GdkPixbuf* Decode(const Json& image) {
  const auto base64 = image.at("data").get<std::string>();
  Check(!base64.empty(), "Expected nonempty image");
  gsize size = 0;
  auto* bytes = g_base64_decode(base64.c_str(), &size);
  auto* loader = gdk_pixbuf_loader_new_with_type("png", nullptr);
  const bool loaded = gdk_pixbuf_loader_write(loader, bytes, size, nullptr) &&
    gdk_pixbuf_loader_close(loader, nullptr);
  g_free(bytes);
  Check(loaded, "Desktop thumbnail is not a PNG");
  auto* pixels = gdk_pixbuf_loader_get_pixbuf(loader);
  Check(pixels != nullptr, "Cannot decode thumbnail");
  g_object_ref(pixels); g_object_unref(loader);
  Check(gdk_pixbuf_get_width(pixels) == image.at("size").at("width") &&
    gdk_pixbuf_get_height(pixels) == image.at("size").at("height"), "PNG dimensions disagree with image metadata");
  return pixels;
}
void ExpectEmpty(const Json& image) {
  Check(image.at("data") == "" && image.at("size").at("width") == 0 &&
    image.at("size").at("height") == 0, "Expected an empty thumbnail");
}
void Rejected(const Json& request) {
  bool rejected = false;
  try { DesktopCaptureSources(request); } catch (const std::exception&) { rejected = true; }
  Check(rejected, "Invalid desktop capture request accepted");
}
int main() {
  try {
    Check(gtk_init_check(nullptr, nullptr), "No GTK display");
    auto* gdk = gdk_display_get_default();
    Check(GDK_IS_X11_DISPLAY(gdk), "Fixture requires X11");
    auto* display = gdk_x11_display_get_xdisplay(gdk);
    const auto root = DefaultRootWindow(display);
    const auto stacking = XInternAtom(display, "_NET_CLIENT_LIST_STACKING", False);
    const auto clients = XInternAtom(display, "_NET_CLIENT_LIST", False);
    XDeleteProperty(display, root, stacking); XDeleteProperty(display, root, clients);
    auto* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), "Weber capture fixture — red pixels");
    gtk_window_set_decorated(GTK_WINDOW(window), FALSE);
    gtk_window_set_default_size(GTK_WINDOW(window), 320, 160);
    gtk_window_move(GTK_WINDOW(window), 20, 20);
    gtk_widget_show_all(window);
    while (gtk_events_pending()) gtk_main_iteration();
    const auto xid = gdk_x11_window_get_xid(gtk_widget_get_window(window));
    const auto id = "window:" + std::to_string(xid) + ":0";
    const auto gc = XCreateGC(display, xid, 0, nullptr);
    XColor exact{}, red{};
    Check(XAllocNamedColor(display, DefaultColormap(display, DefaultScreen(display)), "red", &red, &exact), "Cannot allocate fixture red");
    XSetForeground(display, gc, red.pixel);
    XFillRectangle(display, xid, gc, 0, 0, 320, 160);
    XFreeGC(display, gc);
    const std::vector<unsigned long> icon = {2, 1, 0xff00ff00, 0xff0000ff};
    XChangeProperty(display, xid, XInternAtom(display, "_NET_WM_ICON", False), XA_CARDINAL,
      32, PropModeReplace, reinterpret_cast<const unsigned char*>(icon.data()), icon.size());
    XSync(display, False);
    const Json window_request = {{"captureWindow", true}, {"fetchWindowIcons", true},
      {"thumbnailSize", {{"width", 100}, {"height", 100}}}};
    const auto windows = DesktopCaptureSources(window_request);
    for (const auto& source : windows) Check(source.at("id").get<std::string>().rfind("window:", 0) == 0, "Screen leaked into window-only request");
    const auto& source = Source(windows, id);
    Check(source.at("name") == "Weber capture fixture — red pixels", "UTF-8 window title was lost");
    Check(source.at("display_id") == "", "Window display_id must be empty");
    auto* thumbnail = Decode(source.at("thumbnail"));
    Check(gdk_pixbuf_get_width(thumbnail) == 100 && gdk_pixbuf_get_height(thumbnail) == 50, "Window thumbnail aspect ratio is wrong");
    auto* pixel = gdk_pixbuf_get_pixels(thumbnail) + 25 * gdk_pixbuf_get_rowstride(thumbnail) +
      50 * gdk_pixbuf_get_n_channels(thumbnail);
    Check(pixel[0] > 240 && pixel[1] < 15 && pixel[2] < 15, "Thumbnail does not contain actual red window pixels");
    g_object_unref(thumbnail);
    auto* decoded_icon = Decode(source.at("appIcon"));
    Check(gdk_pixbuf_get_width(decoded_icon) == 2 && gdk_pixbuf_get_height(decoded_icon) == 1, "Window icon dimensions are wrong");
    pixel = gdk_pixbuf_get_pixels(decoded_icon);
    Check(pixel[0] == 0 && pixel[1] == 255 && pixel[2] == 0 && pixel[3] == 255, "Window icon ARGB conversion failed");
    g_object_unref(decoded_icon);

    // Calling capture before screen.displays must still assign the same IDs.
    const auto screens = DesktopCaptureSources({{"captureScreen", true}, {"thumbnailSize", {{"width", 120}, {"height", 80}}}});
    const auto monitors = weber::desktop::DisplayCommand({{"method", "screen.displays"}});
    Check(screens.size() == monitors.size() && !screens.empty(), "Screen sources do not match monitors");
    for (size_t i = 0; i < screens.size(); ++i) {
      Check(screens[i].at("id") == "screen:" + std::to_string(i) + ":0", "Wrong screen source ID");
      Check(screens[i].at("display_id") == std::to_string(monitors[i].at("id").get<uint64_t>()), "Screen display ID differs from screen API");
      auto* screen = Decode(screens[i].at("thumbnail"));
      Check(gdk_pixbuf_get_width(screen) <= 120 && gdk_pixbuf_get_height(screen) <= 80, "Screen thumbnail exceeds requested bounds");
      g_object_unref(screen);
      Check(screens[i].at("appIcon").is_null(), "Screen has an application icon");
    }
    const auto no_thumbnail = DesktopCaptureSources({{"captureWindow", true}, {"captureScreen", true},
      {"thumbnailSize", {{"width", 0}, {"height", 150}}}});
    for (const auto& item : no_thumbnail) { ExpectEmpty(item.at("thumbnail")); Check(item.at("appIcon").is_null(), "Icons fetched without request"); }
    const auto no_height = DesktopCaptureSources({{"captureWindow", true}, {"thumbnailSize", {{"width", 150}, {"height", 0}}}});
    ExpectEmpty(Source(no_height, id).at("thumbnail"));
    Check(DesktopCaptureSources({{"captureWindow", false}, {"captureScreen", false}}).empty(), "Empty types should return no sources");
    Rejected({{"thumbnailSize", {{"width", -1}, {"height", 1}}}});
    Rejected({{"thumbnailSize", {{"width", 1025}, {"height", 1}}}});
    Rejected({{"thumbnailSize", {{"width", 1.5}, {"height", 1}}}});
    Rejected({{"thumbnailSize", {{"width", "1"}, {"height", 1}}}});

    // A real window manager's list can include duplicate and destroyed XIDs.
    // Repeated capture must tolerate both without process-fatal X errors.
    const auto stale = XCreateSimpleWindow(display, root, 0, 0, 1, 1, 0, 0, 0);
    XDestroyWindow(display, stale);
    const std::vector<Window> list = {stale, xid, xid};
    XChangeProperty(display, root, stacking, XA_WINDOW, 32, PropModeReplace,
      reinterpret_cast<const unsigned char*>(list.data()), list.size());
    const auto managed = DesktopCaptureSources(window_request);
    Check(managed.size() == 1, "EWMH duplicate or destroyed window was not filtered");
    Source(managed, id);
    // Malformed icon lengths must not cause overread or an invented icon.
    const std::vector<unsigned long> invalid_icon = {1024, 1024, 0};
    XChangeProperty(display, xid, XInternAtom(display, "_NET_WM_ICON", False), XA_CARDINAL,
      32, PropModeReplace, reinterpret_cast<const unsigned char*>(invalid_icon.data()), invalid_icon.size());
    const auto malformed_icon = DesktopCaptureSources(window_request);
    Check(Source(malformed_icon, id).at("appIcon").is_null(), "Malformed icon must be unavailable");
    gtk_widget_destroy(window);
    while (gtk_events_pending()) gtk_main_iteration();
    XSync(display, False);
    Check(DesktopCaptureSources(window_request).empty(), "Destroyed source was retained");
    XDeleteProperty(display, root, stacking); XDeleteProperty(display, root, clients);
    std::cout << Json{{"ok", true}, {"checks", {"XQueryTree sources", "real thumbnail pixels", "UTF-8 title", "ARGB window icon",
      "screen IDs", "PNG dimensions", "zero thumbnails", "type selection", "invalid dimensions", "EWMH sources", "destroyed windows", "malformed icon"}}}.dump() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}

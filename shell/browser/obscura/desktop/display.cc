// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "display.h"
#include <gtk/gtk.h>
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <sstream>
#include <stdexcept>
namespace weber::desktop {
using Json = nlohmann::json;
namespace {
Json Rect(const GdkRectangle& r) { return {{"x", r.x}, {"y", r.y}, {"width", r.width}, {"height", r.height}}; }
Json Describe(GdkMonitor* monitor) {
  static size_t next_id = 0;
  size_t id = reinterpret_cast<size_t>(g_object_get_data(G_OBJECT(monitor), "weber-display-id"));
  if (!id) { id = ++next_id; g_object_set_data(G_OBJECT(monitor), "weber-display-id", reinterpret_cast<gpointer>(id)); }
  GdkRectangle bounds{}, work{};
  gdk_monitor_get_geometry(monitor, &bounds); gdk_monitor_get_workarea(monitor, &work);
  const char* label = gdk_monitor_get_model(monitor);
  return {{"id", id}, {"bounds", Rect(bounds)}, {"workArea", Rect(work)},
    {"size", {{"width", bounds.width}, {"height", bounds.height}}},
    {"workAreaSize", {{"width", work.width}, {"height", work.height}}},
    {"scaleFactor", gdk_monitor_get_scale_factor(monitor)},
    {"displayFrequency", gdk_monitor_get_refresh_rate(monitor) / 1000.0},
    {"label", label ? label : ""}, {"touchSupport", "unknown"}, {"accelerometerSupport", "unknown"}};
}
}
Json DisplayCommand(const Json& request) {
  const auto method = request.at("method").get<std::string>();
  auto* display = gdk_display_get_default();
  if (!display) throw std::runtime_error("Native display is unavailable");
  if (method == "screen.cursor") {
    auto* seat = gdk_display_get_default_seat(display);
    auto* pointer = seat ? gdk_seat_get_pointer(seat) : nullptr;
    if (!pointer) throw std::runtime_error("Native pointer is unavailable");
    int x = 0, y = 0; gdk_device_get_position(pointer, nullptr, &x, &y);
    return {{"x", x}, {"y", y}};
  }
  if (method == "screen.displays") {
    Json all = Json::array();
    const int count = gdk_display_get_n_monitors(display);
    if (count > 64) throw std::runtime_error("Display count exceeds bounds");
    auto* primary = gdk_display_get_primary_monitor(display);
    for (int i = 0; i < count; ++i) {
      auto* monitor = gdk_display_get_monitor(display, i);
      auto item = Describe(monitor); item["primary"] = monitor == primary || (!primary && i == 0);
      all.push_back(std::move(item));
    }
    return all;
  }
  if (method == "systemPreferences.snapshot") {
    auto* settings = gtk_settings_get_default(); gboolean animations = TRUE;
    g_object_get(settings, "gtk-enable-animations", &animations, nullptr);
    auto* probe = gtk_button_new(); g_object_ref_sink(probe);
    auto* style = gtk_widget_get_style_context(probe); GdkRGBA color{};
    const bool found = gtk_style_context_lookup_color(style, "accent_bg_color", &color) ||
                       gtk_style_context_lookup_color(style, "theme_selected_bg_color", &color);
    std::ostringstream hex;
    if (found) for (double value : {color.red, color.green, color.blue, color.alpha})
      hex << std::hex << std::setfill('0') << std::setw(2) << std::clamp(static_cast<int>(std::lround(value * 255)), 0, 255);
    g_object_unref(probe);
    return {{"accentColor", hex.str()}, {"animationSettings", {
      {"shouldRenderRichAnimation", bool(animations)}, {"scrollAnimationsEnabledBySystem", bool(animations)},
      {"prefersReducedMotion", !bool(animations)}}}};
  }
  throw std::runtime_error("Unsupported native display method");
}
}

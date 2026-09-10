// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "power.h"
#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <X11/extensions/scrnsaver.h>
#include <unistd.h>
#include <algorithm>
#include <stdexcept>
#include <vector>
namespace weber::desktop {
using Json = nlohmann::json;
namespace {
std::string Read(const std::string& path) {
  gchar* data = nullptr; gsize size = 0;
  if (!g_file_get_contents(path.c_str(), &data, &size, nullptr)) return {};
  std::string value(data, size); g_free(data);
  while (!value.empty() && g_ascii_isspace(value.back())) value.pop_back();
  return value;
}
bool BatteryFromKernel() {
  auto* directory = g_dir_open("/sys/class/power_supply", 0, nullptr);
  if (!directory) return false;
  bool battery = false;
  while (const char* name = g_dir_read_name(directory)) {
    const std::string base = std::string("/sys/class/power_supply/") + name + "/";
    if (Read(base + "type") == "Battery" && Read(base + "scope") != "Device" && Read(base + "status") == "Discharging") battery = true;
  }
  g_dir_close(directory); return battery;
}
int IdleSeconds() {
  auto* gdk = gdk_display_get_default();
  if (!GDK_IS_X11_DISPLAY(gdk)) return -1;
  auto* display = gdk_x11_display_get_xdisplay(gdk);
  int event, error;
  if (!XScreenSaverQueryExtension(display, &event, &error)) return -1;
  auto* info = XScreenSaverAllocInfo();
  if (!info) return -1;
  const auto success = XScreenSaverQueryInfo(display, DefaultRootWindow(display), info);
  const auto seconds = success ? info->idle / 1000 : 0;
  XFree(info);
  return success ? static_cast<int>(std::min(seconds, 2147483647ul)) : -1;
}
}
struct PowerMonitor::State {
  std::function<void(Json)> emit;
  GDBusConnection* bus = nullptr;
  std::vector<guint> subscriptions;
  std::string session;
  bool started = false;
  explicit State(std::function<void(Json)> callback) : emit(std::move(callback)) {}
  ~State() {
    if (bus) { for (const auto id : subscriptions) g_dbus_connection_signal_unsubscribe(bus, id); g_object_unref(bus); }
  }
  bool Connect() {
    if (bus) return !g_dbus_connection_is_closed(bus);
    GError* error = nullptr; bus = g_bus_get_sync(G_BUS_TYPE_SYSTEM, nullptr, &error);
    if (error) g_error_free(error);
    return bus;
  }
  GVariant* Call(const char* service, const char* path, const char* interface, const char* method,
                 GVariant* parameters, const GVariantType* reply) {
    GError* error = nullptr;
    auto* result = g_dbus_connection_call_sync(bus, service, path, interface, method, parameters, reply,
      G_DBUS_CALL_FLAGS_NO_AUTO_START, 750, nullptr, &error);
    if (error) g_error_free(error);
    return result;
  }
  void Event(const char* name) { emit({{"event", "power-monitor"}, {"type", name}}); }
  void Start() {
    if (started || !Connect()) return;
    started = true;
    subscriptions.push_back(g_dbus_connection_signal_subscribe(bus, "org.freedesktop.login1", "org.freedesktop.login1.Manager",
      "PrepareForSleep", "/org/freedesktop/login1", nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
      +[](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* parameters, gpointer data) {
        if (!g_variant_is_of_type(parameters, G_VARIANT_TYPE("(b)"))) return;
        gboolean sleeping; g_variant_get(parameters, "(b)", &sleeping);
        try { static_cast<State*>(data)->Event(sleeping ? "suspend" : "resume"); } catch (...) {}
      }, this, nullptr));
    subscriptions.push_back(g_dbus_connection_signal_subscribe(bus, "org.freedesktop.UPower", "org.freedesktop.DBus.Properties",
      "PropertiesChanged", "/org/freedesktop/UPower", "org.freedesktop.UPower", G_DBUS_SIGNAL_FLAGS_NONE,
      +[](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* parameters, gpointer data) {
        if (!g_variant_is_of_type(parameters, G_VARIANT_TYPE("(sa{sv}as)"))) return;
        auto* changed = g_variant_get_child_value(parameters, 1);
        gboolean battery;
        if (g_variant_lookup(changed, "OnBattery", "b", &battery)) {
          try { static_cast<State*>(data)->Event(battery ? "on-battery" : "on-ac"); } catch (...) {}
        }
        g_variant_unref(changed);
      }, this, nullptr));
    auto* result = Call("org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager",
      "GetSessionByPID", g_variant_new("(u)", static_cast<guint>(getpid())), G_VARIANT_TYPE("(o)"));
    if (result) {
      const gchar* path; g_variant_get(result, "(&o)", &path); session = path; g_variant_unref(result);
      subscriptions.push_back(g_dbus_connection_signal_subscribe(bus, "org.freedesktop.login1", "org.freedesktop.login1.Session",
        nullptr, session.c_str(), nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
        +[](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar* name, GVariant*, gpointer data) {
          try {
            if (std::string(name) == "Lock") static_cast<State*>(data)->Event("lock-screen");
            else if (std::string(name) == "Unlock") static_cast<State*>(data)->Event("unlock-screen");
          } catch (...) {}
        }, this, nullptr));
    }
  }
  bool Property(const char* service, const char* path, const char* interface, const char* name, bool fallback) {
    if (!Connect()) return fallback;
    auto* result = Call(service, path, "org.freedesktop.DBus.Properties", "Get", g_variant_new("(ss)", interface, name), G_VARIANT_TYPE("(v)"));
    if (!result) return fallback;
    GVariant* value; g_variant_get(result, "(v)", &value);
    const bool answer = g_variant_is_of_type(value, G_VARIANT_TYPE_BOOLEAN) ? g_variant_get_boolean(value) : fallback;
    g_variant_unref(value); g_variant_unref(result); return answer;
  }
  Json Command(const Json& request) {
    const auto method = request.at("method").get<std::string>();
    if (method == "powerMonitor.start") { Start(); return nullptr; }
    if (method == "powerMonitor.battery") return Property("org.freedesktop.UPower", "/org/freedesktop/UPower", "org.freedesktop.UPower", "OnBattery", BatteryFromKernel());
    if (method == "powerMonitor.idleTime") {
      const int seconds = IdleSeconds();
      if (seconds < 0) throw std::runtime_error("Native idle time is unavailable on this display");
      return seconds;
    }
    if (method == "powerMonitor.idleState") {
      const auto threshold = request.at("threshold").get<int>();
      if (threshold < 1) throw std::runtime_error("Idle threshold must be greater than zero");
      Start();
      if (!session.empty() && Property("org.freedesktop.login1", session.c_str(), "org.freedesktop.login1.Session", "LockedHint", false)) return "locked";
      const int seconds = IdleSeconds();
      return seconds < 0 ? "unknown" : seconds >= threshold ? "idle" : "active";
    }
    throw std::runtime_error("Unsupported native power-monitor operation");
  }
};
PowerMonitor::PowerMonitor(std::function<void(Json)> emit) : state_(std::make_unique<State>(std::move(emit))) {}
PowerMonitor::~PowerMonitor() = default;
Json PowerMonitor::Command(const Json& request) { return state_->Command(request); }
}

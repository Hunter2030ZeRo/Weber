// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "power.h"
#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <X11/extensions/scrnsaver.h>
#include <gio/gunixfdlist.h>
#include <fcntl.h>
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
  // All shutdown state is owned by the GTK context. D-Bus acquisition is
  // asynchronous; neither acquiring an FD nor waiting for JS blocks GTK.
  std::shared_ptr<int> alive = std::make_shared<int>(0);
  GCancellable* acquisition = nullptr;
  guint login_watch = 0;
  gulong bus_closed = 0;
  guint shutdown_timer = 0;
  uint64_t generation = 0;
  int shutdown_fd = -1;
  bool listening = false;
  bool preparing = false;
  bool decision_pending = false;
  bool closed = false;
  std::string login_owner;
  std::string who = "Weber";
  struct Acquisition {
    std::weak_ptr<int> alive;
    State* state;
    uint64_t generation;
  };
  explicit State(std::function<void(Json)> callback) : emit(std::move(callback)) {}
  ~State() {
    alive.reset();
    CloseShutdown();
    if (login_watch) g_bus_unwatch_name(login_watch);
    if (bus && bus_closed) g_signal_handler_disconnect(bus, bus_closed);
    if (bus) { for (const auto id : subscriptions) g_dbus_connection_signal_unsubscribe(bus, id); g_object_unref(bus); }
  }
  void CancelAcquisition() {
    ++generation;
    if (acquisition) { g_cancellable_cancel(acquisition); g_object_unref(acquisition); acquisition = nullptr; }
  }
  void ReleaseShutdown() {
    if (shutdown_timer) { g_source_remove(shutdown_timer); shutdown_timer = 0; }
    if (shutdown_fd >= 0) { close(shutdown_fd); shutdown_fd = -1; }
    decision_pending = false;
  }
  void CloseShutdown() {
    closed = true; listening = false; preparing = false;
    CancelAcquisition(); ReleaseShutdown();
  }
  void ShutdownStatus(const std::string& reason = {}) {
    Json event = {{"event", "power-monitor-shutdown-status"}, {"generation", generation}, {"active", shutdown_fd >= 0}};
    if (!reason.empty()) event["reason"] = reason;
    try { emit(event); } catch (...) {}
  }
  void AcquireShutdown() {
    if (closed || !listening || preparing || shutdown_fd >= 0 || acquisition || login_owner.empty()) return;
    acquisition = g_cancellable_new();
    const auto serial = ++generation;
    // Use the unique owner: replacement cannot redirect an outstanding call
    // to a different daemon. Finish always consumes and closes stale FDs.
    g_dbus_connection_call_with_unix_fd_list(bus, login_owner.c_str(), "/org/freedesktop/login1",
      "org.freedesktop.login1.Manager", "Inhibit",
      g_variant_new("(ssss)", "shutdown", who.c_str(), "Ensure a clean shutdown", "delay"),
      G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, 1000, nullptr, acquisition,
      +[](GObject* connection, GAsyncResult* result, gpointer data) {
        std::unique_ptr<Acquisition> pending(static_cast<Acquisition*>(data));
        GError* error = nullptr; GUnixFDList* fds = nullptr;
        auto* reply = g_dbus_connection_call_with_unix_fd_list_finish(G_DBUS_CONNECTION(connection), &fds, result, &error);
        int fd = -1;
        if (reply && g_variant_is_of_type(reply, G_VARIANT_TYPE("(h)")) && fds) {
          gint handle = -1; g_variant_get(reply, "(h)", &handle);
          if (handle >= 0 && handle < g_unix_fd_list_get_length(fds)) fd = g_unix_fd_list_get(fds, handle, nullptr);
        }
        if (reply) g_variant_unref(reply);
        if (fds) g_object_unref(fds);
        if (!pending->alive.expired()) {
          auto* self = pending->state;
          if (pending->generation == self->generation) {
            g_clear_object(&self->acquisition);
            if (fd >= 0 && fcntl(fd, F_SETFD, FD_CLOEXEC) == 0) {
              self->shutdown_fd = fd; fd = -1;
              self->ShutdownStatus();
            } else {
              self->ShutdownStatus(error ? error->message : "logind returned an invalid shutdown inhibitor descriptor");
            }
          }
        }
        if (fd >= 0) close(fd);
        if (error) g_error_free(error);
      }, new Acquisition{alive, this, serial});
  }
  void PrepareShutdown(bool active) {
    if (closed) return;
    if (!active) {
      preparing = false; CancelAcquisition(); ReleaseShutdown();
      ShutdownStatus(); AcquireShutdown(); return;
    }
    if (preparing) return;
    preparing = true;
    // A notification without an owned delay FD is not a safe shutdown window.
    CancelAcquisition();
    if (!listening || shutdown_fd < 0) return;
    decision_pending = true;
    // logind enforces its own (possibly shorter) deadline. Weber additionally
    // bounds a missing JS decision or a cancelled shutdown to five seconds.
    shutdown_timer = g_timeout_add(5000, +[](gpointer data) -> gboolean {
      auto* self = static_cast<State*>(data);
      self->shutdown_timer = 0;
      self->ReleaseShutdown(); ++self->generation; self->ShutdownStatus();
      return G_SOURCE_REMOVE;
    }, this);
    try { emit({{"event", "power-monitor"}, {"type", "shutdown"}, {"generation", generation}}); }
    catch (...) { ReleaseShutdown(); }
  }
  void WatchShutdown() {
    if (login_watch || closed) return;
    if (!Connect()) { ShutdownStatus("System bus unavailable; shutdown inhibition is inactive"); return; }
    subscriptions.push_back(g_dbus_connection_signal_subscribe(bus, "org.freedesktop.login1", "org.freedesktop.login1.Manager",
      "PrepareForShutdown", "/org/freedesktop/login1", nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
      +[](GDBusConnection*, const gchar* sender, const gchar*, const gchar*, const gchar*, GVariant* parameters, gpointer data) {
        auto* self = static_cast<State*>(data);
        if (self->login_owner != sender || !g_variant_is_of_type(parameters, G_VARIANT_TYPE("(b)"))) return;
        gboolean active; g_variant_get(parameters, "(b)", &active); self->PrepareShutdown(active);
      }, this, nullptr));
    login_watch = g_bus_watch_name_on_connection(bus, "org.freedesktop.login1", G_BUS_NAME_WATCHER_FLAGS_NONE,
      +[](GDBusConnection*, const gchar*, const gchar* owner, gpointer data) {
        auto* self = static_cast<State*>(data);
        if (self->login_owner != owner) {
          self->CancelAcquisition(); self->ReleaseShutdown(); self->preparing = false;
          self->login_owner = owner;
        }
        self->AcquireShutdown();
      }, +[](GDBusConnection*, const gchar*, gpointer data) {
        auto* self = static_cast<State*>(data);
        self->CancelAcquisition(); self->ReleaseShutdown(); self->preparing = false; self->login_owner.clear();
        if (self->listening && !self->closed) self->ShutdownStatus("logind is unavailable; shutdown inhibition is inactive");
      }, this, nullptr);
  }
  bool Connect() {
    if (bus) return !g_dbus_connection_is_closed(bus);
    GError* error = nullptr; bus = g_bus_get_sync(G_BUS_TYPE_SYSTEM, nullptr, &error);
    if (error) g_error_free(error);
    if (bus) {
      g_dbus_connection_set_exit_on_close(bus, FALSE);
      bus_closed = g_signal_connect(bus, "closed", G_CALLBACK(+[](GDBusConnection*, gboolean, GError*, gpointer data) {
        auto* self = static_cast<State*>(data);
        self->CancelAcquisition(); self->ReleaseShutdown(); self->login_owner.clear();
        if (self->listening && !self->closed) self->ShutdownStatus("System bus closed; shutdown inhibition is inactive");
      }), this);
    }
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
    if (method == "powerMonitor.close") { CloseShutdown(); return nullptr; }
    if (method == "powerMonitor.setListeningForShutdown") {
      if (closed) return nullptr;
      listening = request.at("listening").get<bool>();
      who = request.value("who", "Weber");
      if (who.empty() || who.size() > 256) who = "Weber";
      if (listening) { WatchShutdown(); AcquireShutdown(); }
      else {
        // once removal happens before its handler. A preparing cycle owns the
        // lease until the synchronous JS decision, cancellation deadline or exit.
        if (!preparing) { CancelAcquisition(); ReleaseShutdown(); ShutdownStatus(); }
      }
      return nullptr;
    }
    if (method == "powerMonitor.shutdownDecision") {
      const auto serial = request.at("generation").get<uint64_t>();
      const auto prevented = request.at("prevented").get<bool>();
      if (closed || !preparing || !decision_pending || serial != generation) return false;
      decision_pending = false;
      if (!prevented) { ReleaseShutdown(); ShutdownStatus(); }
      return true;
    }
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

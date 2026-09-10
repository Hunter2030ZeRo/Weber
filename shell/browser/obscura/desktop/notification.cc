// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "notification.h"
#include <gio/gio.h>
#include <deque>
#include <map>
#include <stdexcept>
namespace weber::desktop {
using Json = nlohmann::json;
namespace {
constexpr auto kService = "org.freedesktop.Notifications";
constexpr auto kPath = "/org/freedesktop/Notifications";
std::string Text(const Json& value, const char* key, size_t limit, const char* fallback = "") {
  const auto text = value.value(key, std::string(fallback));
  if (text.size() > limit || text.find('\0') != std::string::npos || !g_utf8_validate(text.data(), text.size(), nullptr))
    throw std::runtime_error(std::string("Invalid notification ") + key);
  return text;
}
}
// All state is GTK-thread owned. D-Bus callbacks are asynchronous and have a
// weak owner, so a stopped host cannot be resurrected by a delayed daemon reply.
struct NotificationCenter::State : std::enable_shared_from_this<State> {
  struct Entry { guint server_id = 0; bool busy = false; std::deque<Json> queue; };
  struct Task { std::weak_ptr<State> owner; uint64_t id; bool showing; };
  std::function<void(Json)> emit;
  GDBusConnection* bus = nullptr;
  GCancellable* cancel = g_cancellable_new();
  guint subscription = 0;
  bool stopped = false;
  std::map<uint64_t, Entry> entries;
  explicit State(std::function<void(Json)> callback) : emit(std::move(callback)) {}
  ~State() { Stop(); if (bus) g_object_unref(bus); g_object_unref(cancel); }
  void Stop() {
    if (stopped) return;
    stopped = true;
    if (subscription) g_dbus_connection_signal_unsubscribe(bus, subscription);
    g_cancellable_cancel(cancel);
    entries.clear();
  }
  void Event(uint64_t id, const char* type, const std::string& error = "") {
    if (!stopped) emit({{"event", "notification"}, {"notificationId", id}, {"type", type}, {"error", error}});
  }
  bool Connect() {
    if (bus && !g_dbus_connection_is_closed(bus)) return true;
    // A disconnected bus is not silently replaced while IDs from its daemon
    // are outstanding. A later application restart can establish a new session.
    if (bus) return false;
    GError* error = nullptr;
    bus = g_bus_get_sync(G_BUS_TYPE_SESSION, cancel, &error);
    if (error) g_error_free(error);
    if (!bus) return false;
    subscription = g_dbus_connection_signal_subscribe(bus, kService, kService, nullptr, kPath,
      nullptr, G_DBUS_SIGNAL_FLAGS_NONE, +[](GDBusConnection*, const gchar*, const gchar*, const gchar*,
        const gchar* name, GVariant* parameters, gpointer data) {
        auto* self = static_cast<State*>(data);
        try {
          guint server_id = 0;
          if (std::string(name) == "NotificationClosed" && g_variant_is_of_type(parameters, G_VARIANT_TYPE("(uu)"))) {
            guint reason; g_variant_get(parameters, "(uu)", &server_id, &reason);
            (void)reason;
            for (auto it = self->entries.begin(); it != self->entries.end(); ++it) if (it->second.server_id == server_id) {
              const auto id = it->first; it->second.server_id = 0;
              self->Event(id, "close");
              if (!it->second.busy && it->second.queue.empty()) self->entries.erase(it);
              break;
            }
          } else if (std::string(name) == "ActionInvoked" && g_variant_is_of_type(parameters, G_VARIANT_TYPE("(us)"))) {
            const gchar* action; g_variant_get(parameters, "(u&s)", &server_id, &action);
            if (std::string(action) == "default")
              for (const auto& [id, entry] : self->entries) if (entry.server_id == server_id) { self->Event(id, "click"); break; }
          }
        } catch (...) {} // No C++ exception may escape a GLib callback.
      }, this, nullptr);
    return true;
  }
  bool Supported() {
    if (!Connect()) return false;
    GError* error = nullptr;
    auto* result = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "NameHasOwner", g_variant_new("(s)", kService), G_VARIANT_TYPE("(b)"),
      G_DBUS_CALL_FLAGS_NO_AUTO_START, 750, cancel, &error);
    gboolean supported = FALSE;
    if (result) { g_variant_get(result, "(b)", &supported); g_variant_unref(result); }
    if (error) g_error_free(error);
    return supported;
  }
  void Start(uint64_t id) {
    const auto found = entries.find(id);
    if (found == entries.end() || found->second.busy) return;
    auto& entry = found->second;
    if (entry.queue.empty()) { if (!entry.server_id) entries.erase(found); return; }
    Json request = std::move(entry.queue.front()); entry.queue.pop_front();
    const bool showing = request.at("method") == "notification.show";
    if (!showing && !entry.server_id) { Start(id); return; }
    GVariant* parameters;
    if (showing) {
      const auto& options = request.at("options");
      const auto title = options.at("title").get<std::string>();
      const auto body = options.at("body").get<std::string>();
      const auto icon = options.at("icon").get<std::string>();
      const auto app = options.at("appName").get<std::string>();
      const auto urgency = options.at("urgency").get<std::string>();
      // Escape markup: the Electron body is text, not a desktop-daemon markup API.
      gchar* escaped = g_markup_escape_text(body.c_str(), body.size());
      GVariantBuilder actions, hints;
      g_variant_builder_init(&actions, G_VARIANT_TYPE("as"));
      g_variant_builder_add(&actions, "s", "default"); g_variant_builder_add(&actions, "s", "Open");
      g_variant_builder_init(&hints, G_VARIANT_TYPE("a{sv}"));
      g_variant_builder_add(&hints, "{sv}", "urgency", g_variant_new_byte(urgency == "critical" ? 2 : urgency == "low" ? 0 : 1));
      g_variant_builder_add(&hints, "{sv}", "suppress-sound", g_variant_new_boolean(options.at("silent").get<bool>()));
      parameters = g_variant_new("(susssasa{sv}i)", app.c_str(), entry.server_id, icon.c_str(),
        title.c_str(), escaped, &actions, &hints, options.at("timeoutType") == "never" ? 0 : -1);
      g_free(escaped);
    } else parameters = g_variant_new("(u)", entry.server_id);
    entry.busy = true;
    g_dbus_connection_call(bus, kService, kPath, kService, showing ? "Notify" : "CloseNotification", parameters,
      showing ? G_VARIANT_TYPE("(u)") : G_VARIANT_TYPE("()"), G_DBUS_CALL_FLAGS_NONE, 2500, cancel,
      +[](GObject* object, GAsyncResult* result, gpointer pointer) {
        std::unique_ptr<Task> task(static_cast<Task*>(pointer));
        GError* error = nullptr;
        auto* reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, &error);
        guint server_id = 0;
        if (reply) { if (task->showing) g_variant_get(reply, "(u)", &server_id); g_variant_unref(reply); }
        const std::string message = error ? error->message : "";
        if (error) g_error_free(error);
        if (const auto self = task->owner.lock(); self && !self->stopped) {
          try {
            const auto found = self->entries.find(task->id);
            if (found == self->entries.end()) return;
            auto& entry = found->second; entry.busy = false;
            if (!message.empty() || (task->showing && !server_id)) {
              self->Event(task->id, "failed", message.empty() ? "Desktop daemon returned an invalid notification ID" : message);
            } else if (task->showing) {
              entry.server_id = server_id; self->Event(task->id, "show");
            } else if (entry.server_id) {
              // Some daemons omit NotificationClosed. Complete explicit close
              // once, whether its signal arrived before or after this response.
              entry.server_id = 0; self->Event(task->id, "close");
            }
            self->Start(task->id);
          } catch (const std::exception& failure) { self->Event(task->id, "failed", failure.what()); }
        }
      }, new Task{weak_from_this(), id, showing});
  }
  Json Command(Json request) {
    const auto method = request.at("method").get<std::string>();
    if (method == "notification.isSupported") return Supported();
    if (method != "notification.show" && method != "notification.close") throw std::runtime_error("Unsupported notification operation");
    const auto id = request.at("notificationId").get<uint64_t>();
    if (!id || id > 9007199254740991ull) throw std::runtime_error("Invalid notification ID");
    if (method == "notification.show") {
      auto& options = request.at("options");
      options = {{"title", Text(options, "title", 4096)}, {"body", Text(options, "body", 16384)},
        {"icon", Text(options, "icon", 4096)}, {"appName", Text(options, "appName", 1024)},
        {"urgency", Text(options, "urgency", 16, "normal")}, {"timeoutType", Text(options, "timeoutType", 16, "default")},
        {"silent", options.value("silent", false)}};
      if (options["urgency"] != "normal" && options["urgency"] != "critical" && options["urgency"] != "low") throw std::runtime_error("Invalid notification urgency");
      if (options["timeoutType"] != "default" && options["timeoutType"] != "never") throw std::runtime_error("Invalid notification timeout");
      if (!Connect()) throw std::runtime_error("Desktop notification bus is unavailable");
      if (!entries.count(id) && entries.size() >= 128) throw std::runtime_error("Too many active notifications");
    } else if (!entries.count(id)) return nullptr;
    auto& entry = entries[id];
    if (entry.queue.size() >= 4) throw std::runtime_error("Notification operation queue is full");
    entry.queue.push_back(std::move(request)); Start(id);
    return nullptr;
  }
};
NotificationCenter::NotificationCenter(std::function<void(Json)> emit) : state_(std::make_shared<State>(std::move(emit))) {}
NotificationCenter::~NotificationCenter() { state_->Stop(); }
Json NotificationCenter::Command(const Json& request) { return state_->Command(request); }
}

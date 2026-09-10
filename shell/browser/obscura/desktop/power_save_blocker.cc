// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "power_save_blocker.h"
#include <gio/gio.h>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
namespace weber::desktop {
using Json = nlohmann::json;
namespace {
// GIO connection/authentication can otherwise outlive the platform deadline.
// This cancellation waiter exists only during an effective-mode transition.
struct Deadline {
  GCancellable* cancel = g_cancellable_new();
  std::mutex mutex;
  std::condition_variable wake;
  bool finished = false;
  std::thread thread{[this] {
    std::unique_lock<std::mutex> lock(mutex);
    if (!wake.wait_for(lock, std::chrono::seconds(2), [this] { return finished; })) g_cancellable_cancel(cancel);
  }};
  ~Deadline() {
    { std::lock_guard<std::mutex> lock(mutex); finished = true; }
    wake.notify_one(); thread.join(); g_object_unref(cancel);
  }
};
struct Service { const char* name; const char* path; const char* interface; const char* release; bool gnome; };
constexpr Service gnome{"org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager", "Uninhibit", true};
constexpr Service power{"org.freedesktop.PowerManagement", "/org/freedesktop/PowerManagement/Inhibit", "org.freedesktop.PowerManagement.Inhibit", "UnInhibit", false};
constexpr Service screen{"org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", "UnInhibit", false};
GVariant* Call(GDBusConnection* bus, const char* destination, const char* path, const char* interface,
               const char* method, GVariant* args, const GVariantType* reply, GCancellable* cancel = nullptr, int timeout = 750) {
  GError* error = nullptr;
  auto* result = g_dbus_connection_call_sync(bus, destination, path, interface, method, args, reply,
      G_DBUS_CALL_FLAGS_NO_AUTO_START, timeout, cancel, &error);
  if (error) g_error_free(error);
  return result;
}
std::string Owner(GDBusConnection* bus, const char* name, GCancellable* cancel) {
  auto* result = Call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                      "GetNameOwner", g_variant_new("(s)", name), G_VARIANT_TYPE("(s)"), cancel);
  if (!result) return {};
  const gchar* value; g_variant_get(result, "(&s)", &value);
  std::string owner(value); g_variant_unref(result); return owner;
}
}
struct PowerSaveBlocker::State {
  struct Lease {
    GDBusConnection* bus = nullptr;
    const Service* service = nullptr;
    std::string owner;
    guint cookie = 0, subscription = 0;
    State* parent = nullptr;
    bool acquired = false;
    ~Lease() {
      if (!bus) return;
      g_signal_handlers_disconnect_by_data(bus, this);
      if (subscription) g_dbus_connection_signal_unsubscribe(bus, subscription);
      // Address the unique owner which issued this cookie, never a restarted
      // service that may reuse the same cookie number for an unrelated client.
      if (acquired && !g_dbus_connection_is_closed(bus)) {
        auto* result = Call(bus, owner.c_str(), service->path, service->interface,
                            service->release, g_variant_new("(u)", cookie), G_VARIANT_TYPE("()"), nullptr, 250);
        if (result) g_variant_unref(result);
      }
      // The dedicated connection is also an ownership boundary. A failed or
      // timed-out Inhibit/Uninhibit cannot retain an orphaned client cookie.
      if (!g_dbus_connection_is_closed(bus)) g_dbus_connection_close(bus, nullptr, nullptr, nullptr);
      g_object_unref(bus);
    }
    bool Connect(GCancellable* cancel) {
      GError* error = nullptr;
      gchar* address = g_dbus_address_get_for_bus_sync(G_BUS_TYPE_SESSION, cancel, &error);
      if (!address) { if (error) g_error_free(error); return false; }
      bus = g_dbus_connection_new_for_address_sync(address,
          static_cast<GDBusConnectionFlags>(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
          nullptr, cancel, &error);
      g_free(address);
      if (error) g_error_free(error);
      if (bus) g_dbus_connection_set_exit_on_close(bus, false);
      return bus;
    }
    bool Acquire(const Service& target, const std::string& application, bool display, GCancellable* cancel) {
      service = &target; owner = Owner(bus, target.name, cancel);
      if (owner.empty()) return false;
      auto* args = target.gnome ? g_variant_new("(susu)", application.c_str(), 0u, "Application activity", display ? 8u : 4u) :
          g_variant_new("(ss)", application.c_str(), "Application activity");
      auto* reply = Call(bus, owner.c_str(), target.path, target.interface, "Inhibit", args, G_VARIANT_TYPE("(u)"), cancel);
      if (!reply) return false;
      g_variant_get(reply, "(u)", &cookie); g_variant_unref(reply); acquired = true;
      return true;
    }
    void Watch(State* state) {
      parent = state;
      subscription = g_dbus_connection_signal_subscribe(bus, "org.freedesktop.DBus", "org.freedesktop.DBus",
          "NameOwnerChanged", "/org/freedesktop/DBus", service->name, G_DBUS_SIGNAL_FLAGS_NONE,
          +[](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* args, gpointer data) {
            auto* self = static_cast<Lease*>(data);
            const gchar *name, *old_owner, *new_owner;
            g_variant_get(args, "(&s&s&s)", &name, &old_owner, &new_owner);
            if (self->owner == old_owner && self->owner != new_owner) self->parent->Lost(self);
          }, this, nullptr);
      g_signal_connect(bus, "closed", G_CALLBACK(+[](GDBusConnection*, gboolean, GError*, gpointer data) {
        auto* self = static_cast<Lease*>(data); self->parent->Lost(self);
      }), this);
    }
  };
  std::function<void(Json)> emit;
  std::unique_ptr<Lease> lease;
  std::string mode = "none";
  uint64_t generation = 0;
  explicit State(std::function<void(Json)> callback) : emit(std::move(callback)) {}
  void Lost(Lease* value) {
    if (lease.get() != value) return;
    const auto lost = generation;
    // Do not synchronously call a vanished daemon from its signal callback.
    lease->acquired = false; lease.reset(); mode = "none";
    try { emit({{"event", "power-save-blocker-lost"}, {"generation", lost}}); } catch (...) {}
  }
  Json Command(const Json& request) {
    if (request.at("method") != "powerSaveBlocker.set") throw std::runtime_error("Unsupported power-save blocker operation");
    const auto desired = request.at("mode").get<std::string>();
    if (desired != "none" && desired != "prevent-app-suspension" && desired != "prevent-display-sleep")
      throw std::runtime_error("Invalid power-save blocker type");
    if (desired == mode) return {{"generation", generation}};
    if (desired == "none") { lease.reset(); mode = desired; return {{"generation", ++generation}}; }
    const auto application = request.at("application").get<std::string>();
    if (application.empty() || application.size() > 1024 || application.find('\0') != std::string::npos)
      throw std::runtime_error("Invalid power-save blocker application name");
    std::unique_ptr<Lease> next;
    Deadline deadline;
    for (const auto* service : {&gnome, desired == "prevent-display-sleep" ? &screen : &power}) {
      auto candidate = std::make_unique<Lease>();
      if (candidate->Connect(deadline.cancel) && candidate->Acquire(*service, application, desired == "prevent-display-sleep", deadline.cancel)) {
        candidate->Watch(this);
        // Close the subscription race before acknowledging acquisition.
        if (Owner(candidate->bus, service->name, deadline.cancel) == candidate->owner) { next = std::move(candidate); break; }
      }
      // Each failed candidate closes its own connection, including late replies.
    }
    if (!next) throw std::runtime_error("Operating system power-save inhibition is unavailable");
    // Acquire the replacement first; failure leaves the previous lease intact.
    lease = std::move(next); mode = desired;
    return {{"generation", ++generation}};
  }
};
PowerSaveBlocker::PowerSaveBlocker(std::function<void(Json)> emit) : state_(std::make_unique<State>(std::move(emit))) {}
PowerSaveBlocker::~PowerSaveBlocker() = default;
Json PowerSaveBlocker::Command(const Json& request) { return state_->Command(request); }
}

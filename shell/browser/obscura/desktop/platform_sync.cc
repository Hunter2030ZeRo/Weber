// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
#include "platform_sync.h"
#include "clipboard.h"
#include "display.h"
#include "platform_wire.h"
#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <gdk/gdkkeysyms.h>
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/XKBlib.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <utility>
#include <vector>

namespace weber::desktop {
using Json = nlohmann::json;
using namespace std::chrono_literals;
namespace wire = weber::platform_wire;
struct PlatformSync::State {
  struct Request {
    State* owner;
    Json value;
    Json response;
    std::mutex mutex;
    std::condition_variable wake;
    bool done = false;
    bool cancelled = false;
  };
  using Key = std::pair<unsigned, unsigned>;
  int fd;
  Emit emit;
  std::atomic<bool> stopping{false};
  std::atomic<bool> channel_closed{false};
  std::thread reader;
  std::mutex source_mutex;
  guint source = 0;
  guint cleanup_source = 0;
  std::string closing_error;
  std::shared_ptr<Request> pending;
  GdkDisplay* gdk = nullptr;
  Display* xdisplay = nullptr;
  std::vector<::Window> roots;
  unsigned ignored = LockMask;
  std::map<Key, uint64_t> shortcuts;
  uint64_t last_request = 0;
  Json display_snapshot = Json::array();
  std::string accent_color;
  void PublishDisplays() {
    const auto current = DisplayCommand({{"method", "screen.displays"}});
    for (const auto& item : current) {
      auto old = std::find_if(display_snapshot.begin(), display_snapshot.end(), [&](const Json& previous) { return previous["id"] == item["id"]; });
      if (old == display_snapshot.end()) emit({{"event", "screen-display-added"}, {"display", item}});
      else if (*old != item) {
        Json changed = Json::array();
        for (const auto* field : {"bounds", "workArea", "scaleFactor", "displayFrequency"})
          if ((*old)[field] != item[field]) changed.push_back(field);
        emit({{"event", "screen-display-metrics-changed"}, {"display", item}, {"changed", changed}});
      }
    }
    for (const auto& old : display_snapshot)
      if (std::none_of(current.begin(), current.end(), [&](const Json& item) { return item["id"] == old["id"]; }))
        emit({{"event", "screen-display-removed"}, {"display", old}});
    display_snapshot = current;
  }
  void WatchMonitor(GdkMonitor* monitor) {
    g_signal_connect(monitor, "notify", G_CALLBACK(+[](GObject*, GParamSpec*, gpointer pointer) {
      auto* self = static_cast<State*>(pointer);
      try { self->PublishDisplays(); } catch (...) {}
    }), this);
  }

  State(int socket, Emit callback) : fd(socket), emit(std::move(callback)) {
    wire::Nonblocking(fd);
    gdk = gdk_display_get_default();
    display_snapshot = DisplayCommand({{"method", "screen.displays"}});
    for (int i = 0; i < gdk_display_get_n_monitors(gdk); ++i) WatchMonitor(gdk_display_get_monitor(gdk, i));
    g_signal_connect(gdk, "monitor-added", G_CALLBACK(+[](GdkDisplay*, GdkMonitor* monitor, gpointer pointer) {
      auto* self = static_cast<State*>(pointer); self->WatchMonitor(monitor);
      try { self->PublishDisplays(); } catch (...) {}
    }), this);
    g_signal_connect(gdk, "monitor-removed", G_CALLBACK(+[](GdkDisplay*, GdkMonitor* monitor, gpointer pointer) {
      auto* self = static_cast<State*>(pointer); g_signal_handlers_disconnect_by_data(monitor, self);
      try { self->PublishDisplays(); } catch (...) {}
    }), this);
    accent_color = DisplayCommand({{"method", "systemPreferences.snapshot"}}).value("accentColor", "");
    g_signal_connect(gtk_settings_get_default(), "notify::gtk-theme-name", G_CALLBACK(+[](GObject*, GParamSpec*, gpointer pointer) {
      auto* self = static_cast<State*>(pointer);
      try {
        const auto color = DisplayCommand({{"method", "systemPreferences.snapshot"}}).value("accentColor", "");
        if (color != self->accent_color) { self->accent_color = color; self->emit({{"event", "system-accent-color-changed"}, {"color", color}}); }
      } catch (...) {}
    }), this);
    if (GDK_IS_X11_DISPLAY(gdk)) {
      xdisplay = gdk_x11_display_get_xdisplay(gdk);
      for (int screen = 0; screen < ScreenCount(xdisplay); ++screen)
        roots.push_back(RootWindow(xdisplay, screen));
      ignored |= Modifier(XK_Num_Lock);
      gdk_window_add_filter(nullptr, Filter, this);
    }
  }
  ~State() {
    g_signal_handlers_disconnect_by_data(gdk, this);
    g_signal_handlers_disconnect_by_data(gtk_settings_get_default(), this);
    for (int i = 0; i < gdk_display_get_n_monitors(gdk); ++i)
      g_signal_handlers_disconnect_by_data(gdk_display_get_monitor(gdk, i), this);
    stopping = true;
    shutdown(fd, SHUT_RDWR);
    {
      std::lock_guard<std::mutex> lock(source_mutex);
      if (pending) pending->wake.notify_all();
    }
    if (reader.joinable()) reader.join();
    {
      std::lock_guard<std::mutex> lock(source_mutex);
      if (source) g_source_remove(source);
      if (cleanup_source) g_source_remove(cleanup_source);
      source = 0;
      cleanup_source = 0;
      pending.reset();
    }
    if (xdisplay) {
      UnregisterAll();
      gdk_window_remove_filter(nullptr, Filter, this);
    }
    close(fd);
  }
  unsigned Modifier(KeySym symbol) const {
    unsigned mask = 0;
    const auto keycode = XKeysymToKeycode(xdisplay, symbol);
    XModifierKeymap* map = XGetModifierMapping(xdisplay);
    if (!map) throw std::runtime_error("Cannot read X11 modifier map");
    for (unsigned mod = 0; mod < 8; ++mod)
      for (int key = 0; key < map->max_keypermod; ++key)
        if (keycode && map->modifiermap[mod * map->max_keypermod + key] == keycode) mask |= 1u << mod;
    XFreeModifiermap(map);
    return mask;
  }
  Key Parse(const Json& value) const {
    if (!value.is_string()) throw std::runtime_error("Accelerator must be a string");
    const auto text = value.get<std::string>();
    if (text.empty() || text.size() > 256) throw std::runtime_error("Invalid accelerator length");
    unsigned modifiers = 0;
    std::string key;
    size_t start = 0;
    while (true) {
      const auto end = text.find('+', start);
      auto token = text.substr(start, end == std::string::npos ? end : end - start);
      if (end == std::string::npos) { key = token; break; }
      std::transform(token.begin(), token.end(), token.begin(), [](unsigned char c) { return g_ascii_tolower(c); });
      if (token == "ctrl" || token == "control" || token == "cmdorctrl" || token == "commandorcontrol") modifiers |= ControlMask;
      else if (token == "shift") modifiers |= ShiftMask;
      else if (token == "alt" || token == "option") modifiers |= Mod1Mask;
      else if (token == "super" || token == "meta" || token == "command" || token == "cmd") {
        const auto mask = Modifier(XK_Super_L);
        if (!mask) throw std::runtime_error("X11 keyboard has no Super modifier");
        modifiers |= mask;
      } else throw std::runtime_error("Unsupported accelerator modifier: " + token);
      start = end + 1;
    }
    static const std::map<std::string, std::string> aliases = {
      {"Plus", "plus"}, {"Space", "space"}, {"Enter", "Return"}, {"Esc", "Escape"},
      {"PageUp", "Page_Up"}, {"PageDown", "Page_Down"}, {"Backspace", "BackSpace"},
      {"VolumeUp", "XF86AudioRaiseVolume"}, {"VolumeDown", "XF86AudioLowerVolume"},
      {"VolumeMute", "XF86AudioMute"}, {"MediaNextTrack", "XF86AudioNext"},
      {"MediaPreviousTrack", "XF86AudioPrev"}, {"MediaStop", "XF86AudioStop"},
      {"MediaPlayPause", "XF86AudioPlay"}, {"PrintScreen", "Print"},
    };
    if (const auto found = aliases.find(key); found != aliases.end()) key = found->second;
    guint symbol = gdk_keyval_from_name(key.c_str());
    if (key.size() == 1) symbol = gdk_unicode_to_keyval(static_cast<unsigned char>(key[0]));
    if (!symbol || symbol == GDK_KEY_VoidSymbol) throw std::runtime_error("Invalid accelerator key: " + key);
    symbol = gdk_keyval_to_lower(symbol);
    const unsigned code = XKeysymToKeycode(xdisplay, symbol);
    if (!code) throw std::runtime_error("Accelerator key is unavailable on this X11 keyboard");
    // Symbols such as Plus need the keyboard layout's Shift level even when
    // Electron's accelerator spells the symbol without an explicit Shift.
    if (XkbKeycodeToKeysym(xdisplay, code, 0, 0) != symbol &&
        XkbKeycodeToKeysym(xdisplay, code, 0, 1) == symbol) modifiers |= ShiftMask;
    return {code, modifiers};
  }
  std::vector<unsigned> Variants(unsigned modifiers) const {
    std::vector<unsigned> result;
    // Covers every Caps/Num lock combination, including nonstandard Num lock masks.
    for (unsigned mask = 0; mask < 256; ++mask)
      if ((mask & ~ignored) == 0) result.push_back(modifiers | mask);
    std::sort(result.begin(), result.end());
    result.erase(std::unique(result.begin(), result.end()), result.end());
    return result;
  }
  void Ungrab(Key key) const {
    for (const auto root : roots)
      for (const auto modifiers : Variants(key.second)) XUngrabKey(xdisplay, key.first, modifiers, root);
  }
  bool Register(Key key, uint64_t callback) {
    if (shortcuts.count(key)) return false;
    if (shortcuts.size() >= 256) throw std::runtime_error("Global shortcut registration limit exceeded");
    gdk_x11_display_error_trap_push(gdk);
    for (const auto root : roots)
      for (const auto modifiers : Variants(key.second))
        XGrabKey(xdisplay, key.first, modifiers, root, False, GrabModeAsync, GrabModeAsync);
    const int error = gdk_x11_display_error_trap_pop(gdk);  // Synchronously flushes X errors.
    if (error) {
      // XGrabKey is not atomic across lock variants/screens. Roll back every
      // successful partial grab; never remove another X client's registration.
      Ungrab(key); XSync(xdisplay, False);
      if (error == BadAccess) return false;
      throw std::runtime_error("X11 rejected global shortcut registration: " + std::to_string(error));
    }
    shortcuts.emplace(key, callback);
    return true;
  }
  void UnregisterAll() {
    if (!xdisplay) return;
    for (const auto& item : shortcuts) Ungrab(item.first);
    shortcuts.clear(); XSync(xdisplay, False);
  }
  Json Dispatch(const Json& request) {
    const auto method = request.at("method").get<std::string>();
    if (method.rfind("screen.", 0) == 0 || method.rfind("systemPreferences.", 0) == 0) return weber::desktop::DisplayCommand(request);
    if (method.rfind("clipboard.", 0) == 0) return Clipboard(request);
    if (!xdisplay) throw std::runtime_error("Global shortcuts currently require X11; Wayland portal support is not implemented");
    if (method == "globalShortcut.unregisterAll") { UnregisterAll(); return nullptr; }
    if (method != "globalShortcut.register" && method != "globalShortcut.isRegistered" && method != "globalShortcut.unregister")
      throw std::runtime_error("Unsupported synchronous platform method: " + method);
    const auto key = Parse(request.at("accelerator"));
    if (method == "globalShortcut.register") {
      const auto callback = request.at("callbackId").get<uint64_t>();
      if (!callback || callback > 9007199254740991ull) throw std::runtime_error("Invalid shortcut callback id");
      return Register(key, callback);
    }
    const auto found = shortcuts.find(key);
    if (method == "globalShortcut.isRegistered") return found != shortcuts.end();
    if (found == shortcuts.end()) return nullptr;
    const auto callback = found->second;
    Ungrab(key); shortcuts.erase(found); XSync(xdisplay, False);
    return callback;
  }
  static GdkFilterReturn Filter(GdkXEvent* native, GdkEvent*, gpointer pointer) {
    auto* self = static_cast<State*>(pointer);
    auto* event = static_cast<XEvent*>(native);
    if (self->channel_closed) return GDK_FILTER_CONTINUE;
    if (event->type != KeyPress) return GDK_FILTER_CONTINUE;
    const Key key{event->xkey.keycode, (event->xkey.state & 255u) & ~self->ignored};
    const auto found = self->shortcuts.find(key);
    if (found == self->shortcuts.end()) return GDK_FILTER_CONTINUE;
    self->emit({{"event", "global-shortcut"}, {"callbackId", found->second}});
    return GDK_FILTER_REMOVE;
  }
  static gboolean Execute(gpointer data) {
    const auto task = *static_cast<std::shared_ptr<Request>*>(data);
    auto* self = task->owner;
    bool run;
    {
      std::lock_guard<std::mutex> lock(task->mutex);
      run = !task->cancelled && !self->stopping && !self->channel_closed;
    }
    Json response;
    if (run) {
      // Do not hold the condition-variable mutex across X-server round trips:
      // the reader must be able to expire a stalled native operation promptly.
      try { response = {{"id", task->value.at("id")}, {"result", self->Dispatch(task->value)}}; }
      catch (const std::exception& error) { response = {{"id", task->value.value("id", Json())}, {"error", error.what()}}; }
    }
    {
      std::lock_guard<std::mutex> lock(task->mutex);
      task->response = std::move(response);
      task->done = true;
    }
    { std::lock_guard<std::mutex> source_lock(self->source_mutex); self->source = 0; }
    task->wake.notify_all();
    return G_SOURCE_REMOVE;
  }
  void Run() {
    try {
      while (!stopping) {
        pollfd item{fd, POLLIN, 0};
        const int status = poll(&item, 1, -1);
        if (status < 0 && errno == EINTR) continue;
        if (status == 0) continue;
        if (status < 0 || !(item.revents & POLLIN)) break;
        const auto deadline = wire::Clock::now() + 5s;
        auto task = std::make_shared<Request>(); task->owner = this;
        task->value = Json::parse(wire::Read(fd, deadline));
        if (!task->value.is_object() || !task->value.at("id").is_number_unsigned() ||
            task->value.at("id").get<uint64_t>() != ++last_request)
          throw std::runtime_error("Invalid synchronous platform request sequence");
        {
          std::lock_guard<std::mutex> source_lock(source_mutex);
          pending = task;
          source = g_idle_add_full(G_PRIORITY_DEFAULT, Execute, new std::shared_ptr<Request>(task),
            [](gpointer data) { delete static_cast<std::shared_ptr<Request>*>(data); });
        }
        std::unique_lock<std::mutex> lock(task->mutex);
        if (!task->wake.wait_until(lock, deadline, [&] { return task->done || stopping; })) {
          task->cancelled = true;
          throw std::runtime_error("GTK platform dispatch timed out");
        }
        if (stopping) break;
        wire::Write(fd, task->response.dump(), deadline);
        { std::lock_guard<std::mutex> source_lock(source_mutex); pending.reset(); }
      }
    } catch (const std::exception& error) { closing_error = error.what(); }
    channel_closed = true;
    shutdown(fd, SHUT_RDWR);
    if (!stopping) {
      std::lock_guard<std::mutex> source_lock(source_mutex);
      cleanup_source = g_idle_add_full(G_PRIORITY_DEFAULT, [](gpointer data) -> gboolean {
        auto* self = static_cast<State*>(data);
        { std::lock_guard<std::mutex> lock(self->source_mutex); self->cleanup_source = 0; }
        // Drop OS ownership even if the ordinary stdin transport remains open.
        self->UnregisterAll();
        if (!self->closing_error.empty())
          self->emit({{"event", "platform-sync-error"}, {"error", self->closing_error}});
        return G_SOURCE_REMOVE;
      }, this, nullptr);
    }
  }
};
PlatformSync::PlatformSync(std::unique_ptr<State> state) : state_(std::move(state)) {
  state_->reader = std::thread([this] { state_->Run(); });
}
PlatformSync::~PlatformSync() = default;
std::unique_ptr<PlatformSync> PlatformSync::FromEnvironment(Emit emit) {
  const char* descriptor = std::getenv("WEBER_PLATFORM_FD");
  if (!descriptor) return nullptr;  // Rust/native hosts do not require Node-API.
  if (std::string(descriptor) != "3") throw std::runtime_error("Invalid inherited platform descriptor");
  sockaddr_storage address{}; socklen_t length = sizeof(address);
  if (getpeername(3, reinterpret_cast<sockaddr*>(&address), &length) || address.ss_family != AF_UNIX)
    throw std::runtime_error("Platform descriptor is not a connected private Unix socket");
  if (fcntl(3, F_SETFD, FD_CLOEXEC) < 0) throw std::runtime_error("Cannot protect platform descriptor inheritance");
  return std::unique_ptr<PlatformSync>(new PlatformSync(std::make_unique<State>(3, std::move(emit))));
}
}  // namespace weber::desktop

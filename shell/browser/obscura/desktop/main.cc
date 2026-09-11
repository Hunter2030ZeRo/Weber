// SPDX-License-Identifier: Apache-2.0
// Linux desktop surface for Electron's source-level API adapters. No Chromium.
#include "../renderer_process.h"
#include "../../../common/obscura/wire.h"
#include "menu.h"
#include "platform_sync.h"
#include "async_output.h"
#include "resource_broker.h"
#include "frame.h"
#include "desktop_capture.h"
#include "titlebar_overlay.h"
#include <gtk/gtk.h>
#include <gdk/gdkkeysyms.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <poll.h>
#include <sys/eventfd.h>
#include <cerrno>
#include <cstring>
#include <deque>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <unistd.h>
#include <fcntl.h>
using Json = nlohmann::json;
using namespace std::chrono_literals;
using electron::obscura::RendererProcess;
using weber::desktop::Frame;
namespace {
std::mutex output_mutex;
std::atomic<bool> quitting{false};
std::atomic<bool> output_failed{false};
std::shared_ptr<weber::desktop::AsyncOutput> output_writer;
std::atomic<unsigned> pending_requests{0};
std::string renderer_path;
bool batch_events = false;
void OutputFailed() {
  if (output_failed.exchange(true)) return;
  quitting = true;
  // This also runs on the writer thread. Do not report failure over the failed
  // stream or depend on Ui(), which suppresses callbacks once quitting is set.
  g_idle_add_full(G_PRIORITY_HIGH, [](gpointer) -> gboolean {
    gtk_main_quit(); return G_SOURCE_REMOVE;
  }, nullptr, nullptr);
}
void Emit(const Json& value) {
  try {
    // Keep the previous cross-producer serialization order, but never hold
    // this mutex while waiting for Node/Bun to consume stdout.
    std::lock_guard<std::mutex> lock(output_mutex);
    const auto writer = output_writer;
    if (!writer || !writer->Enqueue(value.dump() + '\n')) OutputFailed();
  } catch (...) { OutputFailed(); }
}
void Reply(const Json& request, const Json& result) {
  if (request.contains("id")) Emit({{"id", request["id"]}, {"result", result}});
}
void Error(const Json& request, const std::string& error) {
  if (request.contains("id")) Emit({{"id", request["id"]}, {"error", error}});
}
void Ui(std::function<void()> function) {
  auto* task = new std::function<void()>(std::move(function));
  g_idle_add_full(G_PRIORITY_DEFAULT, [](gpointer data) -> gboolean {
    if (!quitting) (*static_cast<std::function<void()>*>(data))();
    return G_SOURCE_REMOVE;
  }, task, [](gpointer data) { delete static_cast<std::function<void()>*>(data); });
}
struct Window {
  int id;
  GtkWidget* window = nullptr;
  GtkWidget* box = nullptr;
  GtkWidget* area = nullptr;
  std::unique_ptr<weber::desktop::MenuView> menu;
  std::unique_ptr<weber::desktop::TitleBarOverlay> titlebar;
  std::atomic<bool> closed{false};
  std::mutex mutex;
  int wake_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
  Window() { if (wake_fd < 0) throw std::runtime_error("Window wake channel creation failed"); }
  ~Window() { close(wake_fd); }
  void Wake() {
    uint64_t one = 1;
    while (write(wake_fd, &one, sizeof(one)) < 0 && errno == EINTR) {}
  }
  std::deque<Json> commands;
  std::thread worker;
  std::shared_ptr<weber::desktop::ResourceBroker> resources;
  std::atomic<bool> worker_done{false};
  std::shared_ptr<const Frame> frame; // UI-owned reference to immutable bytes.
  bool frame_pending = false; // protected with pending_frame by mutex
  std::shared_ptr<const Frame> pending_frame;
  int width = 800, height = 600;
  unsigned click_count = 1;
  bool frame_ready = false;
  bool presented = false;
};
std::map<int, std::shared_ptr<Window>> windows;
// The UI owns native widgets. Readers may only acquire a strong reference to a
// live command queue; no GTK object is touched through this routing registry.
std::mutex routes_mutex;
std::map<int, std::weak_ptr<Window>> routes;
std::vector<std::shared_ptr<Window>> retired;
void Queue(const std::shared_ptr<Window>& window, Json command) {
  std::lock_guard<std::mutex> lock(window->mutex);
  if (window->closed) { Error(command, "Window is destroyed"); return; }
  if (window->commands.size() >= 1024) { Error(command, "Window command queue is full"); return; }
  window->commands.push_back(std::move(command));
  window->Wake();
}
void Close(std::shared_ptr<Window> window) {
  if (window->closed.exchange(true)) return;
  window->Wake();
  { std::lock_guard<std::mutex> lock(window->mutex); if (window->resources) window->resources->Cancel(); }
  window->menu.reset();
  window->titlebar.reset();
  gtk_widget_destroy(window->window);
  windows.erase(window->id);
  { std::lock_guard<std::mutex> lock(routes_mutex); routes.erase(window->id); }
  retired.push_back(window);
  Emit({{"event", "closed"}, {"windowId", window->id}});
}
void Present(const std::shared_ptr<Window>& window, std::shared_ptr<const Frame> frame) {
  {
    std::lock_guard<std::mutex> lock(window->mutex);
    window->pending_frame = std::move(frame);
    // Slow UI presentation retains only the newest complete frame and one
    // queued callback. IPC and renderer completions remain independently live.
    if (window->frame_pending) return;
    window->frame_pending = true;
  }
  Ui([window]() {
    {
      std::lock_guard<std::mutex> lock(window->mutex);
      window->frame_pending = false;
      if (window->closed) { window->pending_frame.reset(); return; }
      window->frame = std::move(window->pending_frame);
    }
    if (!window->frame_ready) {
      window->frame_ready = true;
      Emit({{"event", "frame-ready"}, {"windowId", window->id}, {"width", window->frame->width()}, {"height", window->frame->height()}});
    }
    gtk_widget_queue_draw(window->area);
  });
}
Json Decode(const std::vector<uint8_t>& bytes) {
  return Json::parse(bytes.begin(), bytes.end());
}
void Work(std::shared_ptr<Window> window, Json create) {
  bool created = false;
  try {
    auto resources = std::make_shared<weber::desktop::ResourceBroker>([id = window->id](const Json& request) {
      Emit({{"event", "resource-request"}, {"windowId", id}, {"resourceId", request.at("resourceId")}, {"request", request.at("request")}});
    });
    { std::lock_guard<std::mutex> lock(window->mutex); window->resources = resources; }
    bool frame_requested = false;
    std::shared_ptr<const Frame> last_frame;
    RendererProcess renderer(renderer_path, 30000ms, resources->child_fd(), [&](uint32_t kind, std::vector<uint8_t> bytes) {
      if (kind == electron::obscura::wire::kFrameReady) { frame_requested = true; return; }
      const auto batch = Decode(bytes);
      if (batch.value("dropped", 0u)) Emit({{"event", "engine-event-overflow"}, {"windowId", window->id}});
      if (batch_events) {
        Emit({{"event", "engine-events"}, {"windowId", window->id}, {"events", batch.at("events")}});
      } else {
        for (const auto& event : batch.at("events"))
          Emit({{"event", "engine-event"}, {"windowId", window->id}, {"data", event}});
      }
    });
    resources->ChildSpawned();
    renderer.Command(Json{{"method", "viewport"}, {"width", create.value("options", Json::object()).value("width", 800)}, {"height", create.value("options", Json::object()).value("height", 600)}}.dump());
    Reply(create, {{"windowId", window->id}, {"rendererPid", renderer.process_id()}});
    created = true;
    while (!window->closed && !quitting) {
      Json request;
      {
        std::lock_guard<std::mutex> lock(window->mutex);
        if (!window->commands.empty()) { request = std::move(window->commands.front()); window->commands.pop_front(); }
      }
      if (request.is_null() && !frame_requested) {
        pollfd channels[] = {{window->wake_fd, POLLIN, 0}, {renderer.channel_fd(), POLLIN, 0}};
        int ready;
        do { ready = poll(channels, 2, -1); } while (ready < 0 && errno == EINTR);
        if (ready < 0) throw std::runtime_error("Desktop event wait failed");
        if (channels[0].revents) { uint64_t count; while (read(window->wake_fd, &count, sizeof(count)) < 0 && errno == EINTR) {} }
        if (window->closed || quitting) break;
        if (channels[1].revents) renderer.ReceiveNotification();
      }
      if (!request.is_null()) {
        try {
          const Json& command = request.at("command");
          const auto method = command.value("method", "");
          if (method == "loadURL" || method == "loadFile") last_frame.reset();
          if (method == "capturePng") {
            // Check current document damage before reusing pixels. Captures
            // never return an old presentation merely because it was visible.
            frame_requested = false;
            auto bytes = renderer.Command(R"({"method":"captureFrameIfChanged"})");
            if (bytes.empty() && !last_frame) bytes = renderer.Command(R"({"method":"captureFrame"})");
            if (!bytes.empty()) {
              last_frame = Frame::FromRgba(std::move(bytes));
              Present(window, last_frame);
            }
            if (!last_frame) throw std::runtime_error("No frame available for capture");
            auto response = last_frame->Png();
            gchar* encoded = g_base64_encode(response.data(), response.size());
            Reply(request, {{"encoding", "base64"}, {"data", encoded}}); g_free(encoded);
          } else Reply(request, Decode(renderer.Command(command.dump())));

        } catch (const std::exception& error) { Error(request, error.what()); }
      }
      if (frame_requested && !window->closed) {
        frame_requested = false;
        try {
          auto frame = renderer.Command(R"({"method":"captureFrameIfChanged"})");
          if (!frame.empty()) {
            last_frame = Frame::FromRgba(std::move(frame));
            Present(window, last_frame);
          }
        } catch (const std::exception& error) {
          Emit({{"event", "frame-error"}, {"windowId", window->id}, {"error", error.what()}});
          throw; // Do not conceal a failed presentation or leave a stuck subscription.
        }
      }
    }
  } catch (const std::exception& error) {
    if (!created) Error(create, error.what());
    Emit({{"event", "render-process-gone"}, {"windowId", window->id}, {"error", error.what()}});
    Ui([window] { Close(window); });
  }
  std::deque<Json> pending;
  { std::lock_guard<std::mutex> lock(window->mutex); pending.swap(window->commands); }
  for (const auto& request : pending) Error(request, "Window is destroyed");
  { std::lock_guard<std::mutex> lock(window->mutex); window->resources.reset(); }
  window->worker_done = true;
}
void Input(Window* ptr, Json command) {
  auto found = windows.find(ptr->id);
  if (found != windows.end()) Queue(found->second, {{"command", std::move(command)}});
}
unsigned Modifiers(guint state) {
  return (state & GDK_MOD1_MASK ? 1 : 0) | (state & GDK_CONTROL_MASK ? 2 : 0) |
      (state & (GDK_META_MASK | GDK_SUPER_MASK) ? 4 : 0) | (state & GDK_SHIFT_MASK ? 8 : 0);
}
unsigned MouseButtons(guint state) {
  return (state & GDK_BUTTON1_MASK ? 1 : 0) | (state & GDK_BUTTON3_MASK ? 2 : 0) |
      (state & GDK_BUTTON2_MASK ? 4 : 0);
}
const char* MouseButton(guint button) {
  switch (button) {
    case 1: return "left"; case 2: return "middle"; case 3: return "right";
    case 8: return "back"; case 9: return "forward"; default: return "none";
  }
}
unsigned ButtonBit(guint button) {
  switch (button) {
    case 1: return 1; case 2: return 4; case 3: return 2;
    case 8: return 8; case 9: return 16; default: return 0;
  }
}
std::string PrintableKey(guint keyval) {
  const auto unicode = gdk_keyval_to_unicode(keyval);
  if (!unicode || !g_unichar_isprint(unicode)) return {};
  char text[7]{};
  g_unichar_to_utf8(unicode, text);
  return text;
}
std::string DomKey(guint keyval) {
  switch (keyval) {
    case GDK_KEY_Return: case GDK_KEY_KP_Enter: return "Enter";
    case GDK_KEY_BackSpace: return "Backspace";
    case GDK_KEY_Tab: case GDK_KEY_ISO_Left_Tab: case GDK_KEY_KP_Tab: return "Tab";
    case GDK_KEY_Escape: return "Escape";
    case GDK_KEY_Delete: case GDK_KEY_KP_Delete: return "Delete";
    case GDK_KEY_Insert: case GDK_KEY_KP_Insert: return "Insert";
    case GDK_KEY_Left: case GDK_KEY_KP_Left: return "ArrowLeft";
    case GDK_KEY_Right: case GDK_KEY_KP_Right: return "ArrowRight";
    case GDK_KEY_Up: case GDK_KEY_KP_Up: return "ArrowUp";
    case GDK_KEY_Down: case GDK_KEY_KP_Down: return "ArrowDown";
    case GDK_KEY_Home: case GDK_KEY_KP_Home: return "Home";
    case GDK_KEY_End: case GDK_KEY_KP_End: return "End";
    case GDK_KEY_Page_Up: case GDK_KEY_KP_Page_Up: return "PageUp";
    case GDK_KEY_Page_Down: case GDK_KEY_KP_Page_Down: return "PageDown";
    case GDK_KEY_Shift_L: case GDK_KEY_Shift_R: return "Shift";
    case GDK_KEY_Control_L: case GDK_KEY_Control_R: return "Control";
    case GDK_KEY_Alt_L: case GDK_KEY_Alt_R: return "Alt";
    case GDK_KEY_Meta_L: case GDK_KEY_Meta_R:
    case GDK_KEY_Super_L: case GDK_KEY_Super_R: return "Meta";
    case GDK_KEY_Caps_Lock: return "CapsLock";
    case GDK_KEY_Num_Lock: return "NumLock";
    case GDK_KEY_Scroll_Lock: return "ScrollLock";
    default: break;
  }
  if (keyval >= GDK_KEY_F1 && keyval <= GDK_KEY_F35)
    return "F" + std::to_string(keyval - GDK_KEY_F1 + 1);
  auto printable = PrintableKey(keyval);
  return printable.empty() ? "Unidentified" : printable;
}
void Create(const Json& request) {
  const int id = request.at("windowId").get<int>();
  if (id <= 0 || windows.count(id)) throw std::runtime_error("Invalid or duplicate windowId");
  Json options = request.value("options", Json::object());
  auto window = std::make_shared<Window>(); window->id = id;
  window->width = options.value("width", 800); window->height = options.value("height", 600);
  if (window->width < 1 || window->height < 1 || window->width > 8192 || window->height > 8192 ||
      int64_t(window->width) * window->height > 16000000) throw std::runtime_error("Invalid window size");
  window->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  window->box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  window->area = gtk_drawing_area_new();
  gtk_window_set_title(GTK_WINDOW(window->window), options.value("title", "Weber").c_str());
  gtk_window_set_deletable(GTK_WINDOW(window->window), options.value("closable", true));
  gtk_window_set_default_size(GTK_WINDOW(window->window), window->width, window->height);
  gtk_container_add(GTK_CONTAINER(window->window), window->box);
  auto* overlay = gtk_overlay_new();
  gtk_container_add(GTK_CONTAINER(overlay), window->area);
  gtk_box_pack_end(GTK_BOX(window->box), overlay, TRUE, TRUE, 0);
  const bool hidden = options.value("titleBarStyle", "default") == "hidden";
  gtk_window_set_decorated(GTK_WINDOW(window->window), options.value("frame", true) && !hidden);
  const auto titlebar = options.value("titleBarOverlay", Json(false));
  if (hidden && titlebar != false) {
    auto* widget = window->window;
    try {
    window->titlebar = std::make_unique<weber::desktop::TitleBarOverlay>(widget, overlay,
      titlebar == true ? Json::object() : titlebar, options.value("minimizable", true),
      options.value("maximizable", true), options.value("closable", true), [widget](const std::string& action) {
        if (action == "minimize") gtk_window_iconify(GTK_WINDOW(widget));
        else if (action == "maximize") {
          if (gtk_window_is_maximized(GTK_WINDOW(widget))) gtk_window_unmaximize(GTK_WINDOW(widget));
          else gtk_window_maximize(GTK_WINDOW(widget));
        } else gtk_window_close(GTK_WINDOW(widget));
      });
    } catch (...) { gtk_widget_destroy(window->window); throw; }
  }
  window->menu = std::make_unique<weber::desktop::MenuView>(window->window, window->box, id, Emit);
  gtk_widget_set_can_focus(window->area, TRUE);
  gtk_widget_add_events(window->area, GDK_BUTTON_PRESS_MASK | GDK_BUTTON_RELEASE_MASK |
      GDK_POINTER_MOTION_MASK | GDK_KEY_PRESS_MASK | GDK_KEY_RELEASE_MASK |
      GDK_SCROLL_MASK | GDK_SMOOTH_SCROLL_MASK);
  windows[id] = window;
  { std::lock_guard<std::mutex> lock(routes_mutex); routes[id] = window; }
  for (const char* signal : {"focus-in-event", "focus-out-event"})
    g_signal_connect(window->window, signal, G_CALLBACK((+[](GtkWidget*, GdkEventFocus* event, gpointer data) -> gboolean {
      auto* w = static_cast<Window*>(data);
      Emit({{"event", event->in ? "focus" : "blur"}, {"windowId", w->id}});
      return FALSE;
    })), window.get());
  g_signal_connect(window->window, "delete-event", G_CALLBACK((+[](GtkWidget*, GdkEvent*, gpointer data) -> gboolean {
    auto found = windows.find(static_cast<Window*>(data)->id);
    if (found != windows.end()) Emit({{"event", "close-requested"}, {"windowId", found->first}});
    return TRUE;
  })), window.get());
  g_signal_connect(window->area, "draw", G_CALLBACK((+[](GtkWidget*, cairo_t* context, gpointer data) -> gboolean {
    auto* w = static_cast<Window*>(data);
    if (!w->frame) return FALSE;
    cairo_surface_t* surface = nullptr;
    try { surface = w->frame->Surface(); }
    catch (const std::exception& error) {
      Emit({{"event", "frame-error"}, {"windowId", w->id}, {"error", error.what()}});
      return FALSE;
    }
    cairo_set_source_surface(context, surface, 0, 0); cairo_paint(context); cairo_surface_destroy(surface);
    if (!w->presented) { w->presented = true; Emit({{"event", "frame-presented"}, {"windowId", w->id}, {"width", w->frame->width()}, {"height", w->frame->height()}}); }
    return TRUE;
  })), window.get());
  g_signal_connect(window->area, "size-allocate", G_CALLBACK((+[](GtkWidget*, GtkAllocation* size, gpointer data) {
    auto* w = static_cast<Window*>(data);
    if (size->width <= 0 || size->height <= 0 || (size->width == w->width && size->height == w->height)) return;
    w->width = size->width; w->height = size->height;
    Input(w, {{"method", "viewport"}, {"width", size->width}, {"height", size->height}});
    Emit({{"event", "resize"}, {"windowId", w->id}, {"width", size->width}, {"height", size->height}});
  })), window.get());
  for (const char* signal : {"button-press-event", "button-release-event"})
    g_signal_connect(window->area, signal, G_CALLBACK((+[](GtkWidget* area, GdkEventButton* event, gpointer data) -> gboolean {
      auto* w = static_cast<Window*>(data);
      // GTK emits these after the ordinary press; do not dispatch a second
      // mousedown, but preserve detail for the matching release/click.
      if (event->type == GDK_2BUTTON_PRESS || event->type == GDK_3BUTTON_PRESS) {
        w->click_count = event->type == GDK_2BUTTON_PRESS ? 2 : 3; return TRUE;
      }
      const bool released = event->type == GDK_BUTTON_RELEASE;
      if (!released) w->click_count = 1;
      const auto bit = ButtonBit(event->button);
      if (!bit) return FALSE;
      const auto buttons = released ? MouseButtons(event->state) & ~bit : MouseButtons(event->state) | bit;
      gtk_widget_grab_focus(area);
      Input(w, {{"method", "dispatchMouseEvent"}, {"type", released ? "mouseReleased" : "mousePressed"},
        {"x", event->x}, {"y", event->y}, {"button", MouseButton(event->button)},
        {"buttons", buttons}, {"modifiers", Modifiers(event->state)}, {"clickCount", w->click_count}});
      return TRUE;
    })), window.get());
  g_signal_connect(window->area, "motion-notify-event", G_CALLBACK((+[](GtkWidget*, GdkEventMotion* event, gpointer data) -> gboolean {
    Input(static_cast<Window*>(data), {{"method", "dispatchMouseEvent"}, {"type", "mouseMoved"},
      {"x", event->x}, {"y", event->y}, {"buttons", MouseButtons(event->state)},
      {"modifiers", Modifiers(event->state)}}); return TRUE;
  })), window.get());
  g_signal_connect(window->area, "scroll-event", G_CALLBACK((+[](GtkWidget*, GdkEventScroll* event, gpointer data) -> gboolean {
    double dx = 0, dy = 0;
    switch (event->direction) {
      case GDK_SCROLL_UP: dy = -40; break;
      case GDK_SCROLL_DOWN: dy = 40; break;
      case GDK_SCROLL_LEFT: dx = -40; break;
      case GDK_SCROLL_RIGHT: dx = 40; break;
      case GDK_SCROLL_SMOOTH: dx = event->delta_x * 40; dy = event->delta_y * 40; break;
    }
    Input(static_cast<Window*>(data), {{"method", "dispatchMouseEvent"}, {"type", "mouseWheel"},
      {"x", event->x}, {"y", event->y}, {"deltaX", dx}, {"deltaY", dy},
      {"modifiers", Modifiers(event->state)}}); return TRUE;
  })), window.get());
  for (const char* signal : {"key-press-event", "key-release-event"})
    g_signal_connect(window->area, signal, G_CALLBACK((+[](GtkWidget*, GdkEventKey* event, gpointer data) -> gboolean {
      const auto modifiers = Modifiers(event->state);
      const auto text = event->type == GDK_KEY_PRESS && !(modifiers & 7) ? PrintableKey(event->keyval) : std::string();
      Input(static_cast<Window*>(data), {{"method", "dispatchKeyEvent"}, {"type", event->type == GDK_KEY_RELEASE ? "keyUp" : "keyDown"},
        {"key", DomKey(event->keyval)}, {"text", text}, {"modifiers", modifiers}});
      return TRUE;
    })), window.get());
  if (options.value("show", true)) gtk_widget_show_all(window->window);
  window->worker = std::thread(Work, window, request);
}
void Dispatch(const Json& request) {
  try {
    const std::string method = request.at("method");
    if (method == "window.create") { Create(request); return; }
    if (method == "app.quit") {
      Reply(request, nullptr); gtk_main_quit(); return;
    }
    if (method == "desktop.captureSources") {
      Reply(request, weber::desktop::DesktopCaptureSources(request)); return;
    }
    const int id = request.at("windowId");
    auto found = windows.find(id);
    if (found == windows.end()) throw std::runtime_error("Unknown or destroyed window");
    auto window = found->second;
    if (method == "resource.reply") {
      std::shared_ptr<weber::desktop::ResourceBroker> resources;
      { std::lock_guard<std::mutex> lock(window->mutex); resources = window->resources; }
      if (!resources) throw std::runtime_error("Resource channel is unavailable");
      resources->Resolve(request.at("resourceId").get<uint32_t>(), request.at("response"));
      Reply(request, nullptr); return;
    }
    if (method == "page.command") { Queue(window, request); return; }
    if (method == "window.getMenuState") { Reply(request, window->menu->Describe()); return; }
    if (method == "window.getTitleBarOverlayState") {
      Json state = window->titlebar ? window->titlebar->Describe() : Json(nullptr);
      if (!state.is_null()) state["content"] = {{"width", gtk_widget_get_allocated_width(window->area)}, {"height", gtk_widget_get_allocated_height(window->area)}};
      Reply(request, state); return;
    }
    if (method == "window.close") Close(window);
    else if (method == "window.setMenu") window->menu->Set(request.at("menu"));
    else if (method == "window.updateMenu") window->menu->Update(request.at("menu"));
    else if (method == "window.show") gtk_widget_show_all(window->window);
    else if (method == "window.hide") gtk_widget_hide(window->window);
    else if (method == "window.setTitle") gtk_window_set_title(GTK_WINDOW(window->window), request.at("title").get<std::string>().c_str());
    else if (method == "window.setTitleBarOverlay") {
      if (!window->titlebar) throw std::runtime_error("Title bar overlay is not enabled for this window");
      window->titlebar->Update(request.at("options"));
    }
    else if (method == "window.setBounds") {
      const auto& bounds = request.at("bounds");
      const int width = bounds.value("width", window->width), height = bounds.value("height", window->height);
      if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || int64_t(width)*height > 16000000)
        throw std::runtime_error("Invalid bounds");
      gtk_window_resize(GTK_WINDOW(window->window), width, height);
      if (bounds.contains("x") && bounds.contains("y")) gtk_window_move(GTK_WINDOW(window->window), bounds["x"], bounds["y"]);
    } else throw std::runtime_error("Unsupported desktop command: " + method);
    Reply(request, nullptr);
  } catch (const std::exception& error) { Error(request, error.what()); }
}
void ReadCommands() {
  std::string line; char bytes[4096];
  while (!quitting) {
    const auto size = read(STDIN_FILENO, bytes, sizeof(bytes));
    if (size < 0 && errno == EINTR) continue;
    if (size <= 0) break;
    for (ssize_t i = 0; i < size; ++i) {
      if (bytes[i] == '\n') {
        try {
          auto request = Json::parse(line);
          // Earlier window operations are ordering barriers. Once dispatched,
          // ordinary page/IPC work can go straight to its window owner without
          // an extra GTK loop hop. Queue() still checks close and capacity.
          if (request.value("method", "") == "page.command" && pending_requests.load() == 0) {
            std::shared_ptr<Window> target;
            { std::lock_guard<std::mutex> lock(routes_mutex);
              const auto found = routes.find(request.at("windowId").get<int>());
              if (found != routes.end()) target = found->second.lock(); }
            if (target) Queue(target, std::move(request));
            else Error(request, "Unknown or destroyed window");
            line.clear();
            continue;
          }
          if (pending_requests.fetch_add(1) >= 1024) {
            --pending_requests;
            Error(request, "Desktop request queue is full");
          } else Ui([request] { Dispatch(request); --pending_requests; });
        }
        catch (const std::exception& error) { Emit({{"event", "protocol-error"}, {"error", error.what()}}); }
        line.clear();
      } else {
        line += bytes[i];
        if (line.size() > 1024 * 1024) { Emit({{"event", "protocol-error"}, {"error", "Request exceeds limit"}}); Ui([] { gtk_main_quit(); }); return; }
      }
    }
  }
  Ui([] { gtk_main_quit(); });
}
} // namespace
int main(int argc, char** argv) {
  if ((argc != 2 && argc != 3) || argv[1][0] != '/') { std::cerr << "Usage: weber-desktop-host /absolute/path/weber-obscura-renderer [--weber-batch-events]\n"; return 2; }
  batch_events = argc == 3 && std::string(argv[2]) == "--weber-batch-events";
  if (argc == 3 && !batch_events) return 2;
  const char* development = std::getenv("WEBER_UNSANDBOXED_DEVELOPMENT");
  if (!development || std::string(development) != "1") {
    std::cerr << "This development runtime has no OS sandbox; set WEBER_UNSANDBOXED_DEVELOPMENT=1 for trusted local test apps.\n";
    return 2;
  }
  renderer_path = argv[1];
  if (!gtk_init_check(nullptr, nullptr)) { std::cerr << "No desktop display available\n"; return 2; }
  try {
    const int descriptor = fcntl(STDOUT_FILENO, F_DUPFD_CLOEXEC, 3);
    if (descriptor < 0) throw std::runtime_error("Cannot own desktop output descriptor");
    output_writer = std::make_shared<weber::desktop::AsyncOutput>(descriptor, OutputFailed);
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 2; }
  std::unique_ptr<weber::desktop::PlatformSync> platform;
  try { platform = weber::desktop::PlatformSync::FromEnvironment(Emit); }
  catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 2; }
  std::thread(ReadCommands).detach();
  // Reap closed windows during app lifetime; do not retain their frames and
  // completed worker threads until the last application window closes.
  g_timeout_add(100, [](gpointer) -> gboolean {
    for (auto it = retired.begin(); it != retired.end();) {
      if ((*it)->worker_done) {
        if ((*it)->worker.joinable()) (*it)->worker.join();
        it = retired.erase(it);
      } else ++it;
    }
    return G_SOURCE_CONTINUE;
  }, nullptr);
  Emit({{"event", "ready"}, {"protocol", 1}, {"engine", "obscura"}});
  gtk_main(); quitting = true;
  platform.reset();
  for (const auto& item : windows) { item.second->closed = true; item.second->Wake(); retired.push_back(item.second); }
  windows.clear();
  { std::lock_guard<std::mutex> lock(routes_mutex); routes.clear(); }
  for (auto& window : retired) if (window->worker.joinable()) window->worker.join();
  // Keep shared ownership available to any final detached reader callback.
  // Finish rejects later enqueues and waits only for its bounded drain deadline.
  const auto writer = output_writer;
  const bool delivered = writer->Finish();
  return delivered && !output_failed ? 0 : 1;
}

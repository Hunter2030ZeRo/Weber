// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
#ifndef WEBER_DESKTOP_MENU_H_
#define WEBER_DESKTOP_MENU_H_

#include <gtk/gtk.h>
#include <nlohmann/json.hpp>

#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>

namespace weber::desktop {

// Native GTK menus. Template policy and role execution stay in Electron's
// original Menu/MenuItem JavaScript modules in the owner main process.
class MenuView {
 public:
  using Json = nlohmann::json;
  using Emit = std::function<void(Json)>;
  MenuView(GtkWidget* window, GtkWidget* box, int window_id, Emit emit,
           bool allowed = true, bool auto_hide = false)
      : window_(window), box_(box), window_id_(window_id), emit_(std::move(emit)),
        allowed_(allowed), auto_hide_(auto_hide) {
    for (const auto* signal : {"key-press-event", "key-release-event"})
      g_signal_connect(window_, signal, G_CALLBACK(+[](GtkWidget*, GdkEventKey* event, gpointer data) -> gboolean {
        return static_cast<MenuView*>(data)->Key(event);
      }), this);
    g_signal_connect(window_, "focus-out-event", G_CALLBACK(+[](GtkWidget*, GdkEventFocus*, gpointer data) -> gboolean {
      auto* self = static_cast<MenuView*>(data);
      self->alt_pressed_ = false;
      self->HideAuto();
      return FALSE;
    }), this);
  }
  ~MenuView() { g_signal_handlers_disconnect_by_data(window_, this); Clear(); }

  void SetVisible(bool visible) {
    if (!bar_ || !allowed_) return;
    visible_ = visible;
    gtk_widget_set_no_show_all(bar_, !visible);
    gtk_widget_set_visible(bar_, visible);
    Notify();
  }
  void SetAutoHide(bool auto_hide) { auto_hide_ = auto_hide; alt_pressed_ = false; Notify(); }
  void HideAuto() { if (auto_hide_ && visible_) SetVisible(false); }
  bool Key(GdkEventKey* event) {
    if (!bar_ || !allowed_) return false;
    const bool alt = event->keyval == GDK_KEY_Alt_L || event->keyval == GDK_KEY_Alt_R;
    if (alt && event->type == GDK_KEY_PRESS) {
      alt_pressed_ = !(event->state & (GDK_CONTROL_MASK | GDK_SHIFT_MASK | GDK_SUPER_MASK));
      return auto_hide_;
    }
    if (alt && event->type == GDK_KEY_RELEASE) {
      const bool toggle = alt_pressed_ && auto_hide_;
      alt_pressed_ = false;
      if (toggle) { SetVisible(!visible_); return true; }
    } else if (event->type == GDK_KEY_PRESS) {
      alt_pressed_ = false;
      if (event->keyval == GDK_KEY_Escape && auto_hide_ && visible_) { SetVisible(false); return true; }
    }
    return false;
  }

  void Set(const Json& menu) {
    Validate(menu);
    const bool had_menu = bar_ != nullptr;
    const bool was_visible = visible_;
    Clear();
    if (menu.is_null()) { visible_ = false; Notify(); return; }
    root_menu_id_ = menu.at("menuId").get<int>();
    accel_ = gtk_accel_group_new();
    gtk_window_add_accel_group(GTK_WINDOW(window_), accel_);
    bar_ = gtk_menu_bar_new();
    gtk_box_pack_start(GTK_BOX(box_), bar_, FALSE, FALSE, 0);
    gtk_box_reorder_child(GTK_BOX(box_), bar_, 0);
    Build(bar_, menu.at("items"));
    visible_ = allowed_ && (had_menu ? was_visible : !auto_hide_);
    gtk_widget_set_no_show_all(bar_, !visible_);
    gtk_widget_set_visible(bar_, visible_);
    g_signal_connect(bar_, "deactivate", G_CALLBACK(+[](GtkWidget*, gpointer data) {
      static_cast<MenuView*>(data)->HideAuto();
    }), this);
    Notify();
  }

  void Update(const Json& menu) {
    Validate(menu);
    if (menu.is_null() || !bar_ || menu.at("menuId").get<int>() != root_menu_id_)
      throw std::runtime_error("Cannot update a detached menu");
    syncing_ = true;
    UpdateItems(menu.at("items"));
    syncing_ = false;
  }

  Json Describe() const {
    Json items = Json::array();
    for (const auto& [command, widget] : widgets_) {
      GtkAllocation allocation;
      gtk_widget_get_allocation(widget, &allocation);
      auto* toplevel = gtk_widget_get_toplevel(widget);
      auto* native = gtk_widget_get_window(toplevel);
      int x = 0, y = 0, origin_x = 0, origin_y = 0;
      const bool translated = gtk_widget_translate_coordinates(widget, toplevel, 0, 0, &x, &y);
      if (native) gdk_window_get_origin(native, &origin_x, &origin_y);
      items.push_back({{"menuId", command.first}, {"commandId", command.second},
        {"mapped", bool(gtk_widget_get_mapped(widget))}, {"visible", bool(gtk_widget_get_visible(widget))},
        {"enabled", bool(gtk_widget_get_sensitive(widget))}, {"translated", translated},
        {"x", origin_x + x}, {"y", origin_y + y}, {"width", allocation.width}, {"height", allocation.height}});
    }
    return {{"menuId", root_menu_id_}, {"barVisible", visible_}, {"autoHide", auto_hide_}, {"barMapped", bar_ && gtk_widget_get_mapped(bar_)}, {"opens", opens_}, {"activations", activations_}, {"items", items}};
  }

 private:
  void Notify() {
    emit_({{"event", "menu-bar-state"}, {"windowId", window_id_},
      {"visible", visible_}, {"autoHide", auto_hide_}});
  }
  struct Activation {
    MenuView* owner;
    int menu_id;
    int command_id;
  };
  static std::string Mnemonic(const std::string& label) {
    std::string result;
    for (size_t i = 0; i < label.size(); ++i) {
      const auto c = label[i];
      if (c == '_') result += "__";
      else if (c == '&' && i + 1 < label.size() && label[i + 1] == '&') { result += '&'; ++i; }
      else result += c == '&' ? '_' : c;
    }
    return result;
  }
  static std::pair<guint, GdkModifierType> Accelerator(const std::string& accelerator) {
    if (accelerator.empty()) return {0, GdkModifierType(0)};
    std::string gtk;
    size_t start = 0;
    while (true) {
      auto end = accelerator.find('+', start);
      const auto token = accelerator.substr(start, end == std::string::npos ? end : end - start);
      if (end == std::string::npos) {
        if (token == "Plus") gtk += "plus";
        else if (token == "Space") gtk += "space";
        else if (token == "Enter") gtk += "Return";
        else if (token == "Esc") gtk += "Escape";
        else if (token == "Up" || token == "Down" || token == "Left" || token == "Right") gtk += token;
        else if (token == "PageUp") gtk += "Page_Up";
        else if (token == "PageDown") gtk += "Page_Down";
        else if (token == "+") gtk += "plus";
        else gtk += token;
        break;
      }
      if (token == "CommandOrControl" || token == "CmdOrCtrl" || token == "Control" || token == "Ctrl") gtk += "<Control>";
      else if (token == "Shift") gtk += "<Shift>";
      else if (token == "Alt" || token == "Option") gtk += "<Alt>";
      else if (token == "Super" || token == "Meta" || token == "Command" || token == "Cmd") gtk += "<Super>";
      else throw std::runtime_error("Unsupported menu accelerator modifier: " + token);
      start = end + 1;
    }
    guint key = 0;
    GdkModifierType modifiers{};
    gtk_accelerator_parse(gtk.c_str(), &key, &modifiers);
    if (!key) throw std::runtime_error("Invalid menu accelerator: " + accelerator);
    return {key, modifiers};
  }
  static void ValidateItems(const Json& items, unsigned depth, unsigned& count) {
    if (!items.is_array() || depth > 16) throw std::runtime_error("Invalid menu nesting");
    for (const auto& item : items) {
      if (++count > 2048) throw std::runtime_error("Menu exceeds 2048 entries");
      const auto type = item.at("type").get<std::string>();
      if (type != "normal" && type != "separator" && type != "checkbox" && type != "radio" && type != "submenu")
        throw std::runtime_error("Unsupported native menu type: " + type);
      if (item.at("menuId").get<int>() <= 0 || item.at("commandId").get<int>() <= 0)
        throw std::runtime_error("Invalid menu command ID");
      (void)item.at("label").get<std::string>();
      (void)item.at("enabled").get<bool>();
      (void)item.at("visible").get<bool>();
      (void)item.at("checked").get<bool>();
      (void)Accelerator(item.value("accelerator", ""));
      if (item.contains("submenu")) ValidateItems(item.at("submenu"), depth + 1, count);
    }
  }
  static void Validate(const Json& menu) {
    if (menu.is_null()) return;
    if (menu.at("menuId").get<int>() <= 0) throw std::runtime_error("Invalid menu ID");
    unsigned count = 0;
    ValidateItems(menu.at("items"), 0, count);
  }
  void Clear() {
    widgets_.clear();
    if (bar_) { gtk_widget_destroy(bar_); bar_ = nullptr; }
    if (accel_) {
      gtk_window_remove_accel_group(GTK_WINDOW(window_), accel_);
      g_object_unref(accel_);
      accel_ = nullptr;
    }
    root_menu_id_ = 0;
  }
  void Build(GtkWidget* shell, const Json& items) {
    for (const auto& item : items) {
      const std::string type = item.at("type");
      const auto label = Mnemonic(item.at("label").get<std::string>());
      GtkWidget* widget;
      if (type == "separator") widget = gtk_separator_menu_item_new();
      else if (type == "checkbox" || type == "radio") {
        widget = gtk_check_menu_item_new_with_mnemonic(label.c_str());
        gtk_check_menu_item_set_draw_as_radio(GTK_CHECK_MENU_ITEM(widget), type == "radio");
      } else widget = gtk_menu_item_new_with_mnemonic(label.c_str());
      gtk_menu_shell_append(GTK_MENU_SHELL(shell), widget);
      widgets_[{item.at("menuId").get<int>(), item.at("commandId").get<int>()}] = widget;
      Apply(widget, item);
      if (item.contains("submenu")) {
        auto* submenu = gtk_menu_new();
        gtk_menu_item_set_submenu(GTK_MENU_ITEM(widget), submenu);
        Build(submenu, item.at("submenu"));
        g_signal_connect(submenu, "show", G_CALLBACK((+[](GtkWidget*, gpointer data) {
          auto* self = static_cast<MenuView*>(data);
          ++self->opens_;
          self->emit_({{"event", "menu-will-show"}, {"windowId", self->window_id_}});
        })), this);
      } else if (type != "separator") {
        auto* activation = new Activation{this, item.at("menuId").get<int>(), item.at("commandId").get<int>()};
        g_signal_connect_data(widget, "activate", G_CALLBACK((+[](GtkWidget*, gpointer data) {
          auto* activation = static_cast<Activation*>(data);
          auto* self = activation->owner;
          if (self->syncing_) return;
          ++self->activations_;
          GdkModifierType state{};
          gtk_get_current_event_state(&state);
          auto* current_event = gtk_get_current_event();
          const auto event_type = current_event ? current_event->type : GDK_NOTHING;
          if (current_event) gdk_event_free(current_event);
          const unsigned modifiers = (state & GDK_MOD1_MASK ? 1 : 0) | (state & GDK_CONTROL_MASK ? 2 : 0) |
              (state & (GDK_META_MASK | GDK_SUPER_MASK) ? 4 : 0) | (state & GDK_SHIFT_MASK ? 8 : 0);
          self->emit_({{"event", "menu-click"}, {"windowId", self->window_id_},
            {"menuId", activation->menu_id}, {"commandId", activation->command_id},
            {"modifiers", modifiers}, {"accelerator", event_type == GDK_KEY_PRESS || event_type == GDK_KEY_RELEASE}});
        })), activation, +[](gpointer data, GClosure*) { delete static_cast<Activation*>(data); }, GConnectFlags(0));
      }
      const auto [key, modifiers] = Accelerator(item.value("accelerator", ""));
      if (key && (item.at("visible").get<bool>() || item.value("acceleratorWorksWhenHidden", true)))
        gtk_widget_add_accelerator(widget, "activate", accel_, key, modifiers, GTK_ACCEL_VISIBLE);
    }
  }
  void Apply(GtkWidget* widget, const Json& item) {
    const bool visible = item.at("visible");
    gtk_widget_set_no_show_all(widget, !visible);
    gtk_widget_set_visible(widget, visible);
    gtk_widget_set_sensitive(widget, item.at("enabled").get<bool>());
    if (item.at("type") != "separator") {
      const auto label = Mnemonic(item.at("label").get<std::string>());
      gtk_menu_item_set_label(GTK_MENU_ITEM(widget), label.c_str());
      gtk_menu_item_set_use_underline(GTK_MENU_ITEM(widget), TRUE);
    }
    if (GTK_IS_CHECK_MENU_ITEM(widget)) gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(widget), item.at("checked").get<bool>());
    const auto tooltip = item.value("toolTip", "");
    gtk_widget_set_tooltip_text(widget, tooltip.empty() ? nullptr : tooltip.c_str());
  }
  void UpdateItems(const Json& items) {
    for (const auto& item : items) {
      const auto found = widgets_.find({item.at("menuId").get<int>(), item.at("commandId").get<int>()});
      if (found != widgets_.end()) Apply(found->second, item);
      if (item.contains("submenu")) UpdateItems(item.at("submenu"));
    }
  }
  GtkWidget* window_;
  GtkWidget* box_;
  int window_id_;
  Emit emit_;
  GtkWidget* bar_ = nullptr;
  GtkAccelGroup* accel_ = nullptr;
  int root_menu_id_ = 0;
  bool syncing_ = false;
  bool allowed_ = true, auto_hide_ = false, visible_ = false, alt_pressed_ = false;
  unsigned opens_ = 0;
  unsigned activations_ = 0;
  std::map<std::pair<int, int>, GtkWidget*> widgets_;
};

}  // namespace weber::desktop
#endif  // WEBER_DESKTOP_MENU_H_


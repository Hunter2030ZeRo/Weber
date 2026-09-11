// Copyright Weber contributors. SPDX-License-Identifier: MIT
#pragma once
#include <gtk/gtk.h>
#include <nlohmann/json.hpp>
#include <array>
#include <cmath>
#include <functional>
#include <stdexcept>
#include <string>
namespace weber::desktop {
// Native window controls overlap (and do not shrink) the content allocation.
// This class owns its widget references and disconnects every window callback.
class TitleBarOverlay {
 public:
  using Json = nlohmann::json;
  using Action = std::function<void(const std::string&)>;
  TitleBarOverlay(GtkWidget* window, GtkWidget* overlay, const Json& options,
                  bool minimize, bool maximize, bool close, Action action)
      : window_(window), action_(std::move(action)), enabled_{{minimize, maximize, close}} {
    ApplyOptions(options); // Validate before allocating or changing any widgets.
    controls_ = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
    g_object_ref_sink(controls_);
    gtk_widget_set_halign(controls_, GTK_ALIGN_END);
    gtk_widget_set_valign(controls_, GTK_ALIGN_START);
    gtk_overlay_add_overlay(GTK_OVERLAY(overlay), controls_);
    gtk_overlay_set_overlay_pass_through(GTK_OVERLAY(overlay), controls_, FALSE);
    for (int i = 0; i < 3; ++i) {
      auto* button = gtk_button_new(); buttons_[i] = button;
      gtk_widget_set_name(button, "weber-window-control");
      gtk_widget_set_tooltip_text(button, names_[i]);
      atk_object_set_name(gtk_widget_get_accessible(button), names_[i]);
      gtk_widget_set_sensitive(button, enabled_[i]);
      gtk_widget_set_can_focus(button, TRUE);
      gtk_box_pack_start(GTK_BOX(controls_), button, FALSE, FALSE, 0);
      auto* icon = gtk_drawing_area_new();
      gtk_container_add(GTK_CONTAINER(button), icon);
      g_object_set_data(G_OBJECT(button), "weber-control-index", GINT_TO_POINTER(i));
      g_object_set_data(G_OBJECT(icon), "weber-control-index", GINT_TO_POINTER(i));
      g_signal_connect(icon, "draw", G_CALLBACK(+[](GtkWidget* widget, cairo_t* cr, gpointer data) -> gboolean {
        auto* self = static_cast<TitleBarOverlay*>(data);
        const int index = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(widget), "weber-control-index"));
        const double x = std::floor(gtk_widget_get_allocated_width(widget) / 2.0) + 0.5;
        const double y = std::floor(gtk_widget_get_allocated_height(widget) / 2.0) + 0.5;
        gdk_cairo_set_source_rgba(cr, &self->symbol_); cairo_set_line_width(cr, 1.0);
        if (index == 0) { cairo_move_to(cr, x - 5, y + 3); cairo_line_to(cr, x + 5, y + 3); }
        else if (index == 1) {
          cairo_rectangle(cr, x - 5, y - 5, 10, 10);
          if (gtk_window_is_maximized(GTK_WINDOW(self->window_))) {
            cairo_move_to(cr, x - 2, y - 7); cairo_line_to(cr, x + 7, y - 7); cairo_line_to(cr, x + 7, y + 2);
          }
        } else {
          cairo_move_to(cr, x - 5, y - 5); cairo_line_to(cr, x + 5, y + 5);
          cairo_move_to(cr, x + 5, y - 5); cairo_line_to(cr, x - 5, y + 5);
        }
        cairo_stroke(cr); return FALSE;
      }), this);
      g_signal_connect(button, "clicked", G_CALLBACK(+[](GtkButton* button, gpointer data) {
        auto* self = static_cast<TitleBarOverlay*>(data);
        const int index = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(button), "weber-control-index"));
        const auto callback = self->action_; // close may destroy this instance.
        callback(index == 0 ? "minimize" : index == 1 ? "maximize" : "close");
      }), this);
    }
    g_signal_connect(window_, "window-state-event", G_CALLBACK(+[](GtkWidget*, GdkEventWindowState* event, gpointer data) -> gboolean {
      auto* self = static_cast<TitleBarOverlay*>(data);
      const bool fullscreen = event->new_window_state & GDK_WINDOW_STATE_FULLSCREEN;
      gtk_widget_set_no_show_all(self->controls_, fullscreen);
      gtk_widget_set_visible(self->controls_, !fullscreen);
      gtk_widget_queue_draw(self->controls_);
      return FALSE;
    }), this);
    Restyle();
  }
  ~TitleBarOverlay() {
    g_signal_handlers_disconnect_by_data(window_, this);
    gtk_widget_destroy(controls_);
    g_object_unref(controls_);
    if (provider_) g_object_unref(provider_);
  }
  void Update(const Json& options) { ApplyOptions(options); Restyle(); }
  Json Describe() const {
    GtkAllocation allocation; gtk_widget_get_allocation(controls_, &allocation);
    int x = allocation.x, y = allocation.y;
    gtk_widget_translate_coordinates(controls_, window_, 0, 0, &x, &y);
    gchar* color = gdk_rgba_to_string(&background_); gchar* symbol = gdk_rgba_to_string(&symbol_);
    Json result = {{"color", color}, {"symbolColor", symbol}, {"height", height_},
      {"visible", static_cast<bool>(gtk_widget_get_visible(controls_))},
      {"controls", {{"x", x}, {"y", y}, {"width", allocation.width}, {"height", allocation.height}}}};
    g_free(color); g_free(symbol); return result;
  }
 private:
  void ApplyOptions(const Json& changes) {
    if (!changes.is_object()) throw std::runtime_error("Title bar overlay options must be an object");
    auto merged = options_;
    for (const char* key : {"color", "symbolColor", "height"}) if (changes.contains(key)) merged[key] = changes[key];
    int height = 32;
    if (merged.contains("height")) {
      if (!merged["height"].is_number_integer()) throw std::runtime_error("Overlay height must be an integer");
      const auto value = merged["height"].get<int64_t>();
      if (value < 0 || value > 512) throw std::runtime_error("Invalid overlay height");
      if (value > 0) height = static_cast<int>(value);
    }
    GdkRGBA background{0.93, 0.93, 0.93, 1.0}, symbol{0, 0, 0, 1};
    auto* context = gtk_widget_get_style_context(window_);
    gtk_style_context_lookup_color(context, "theme_bg_color", &background);
    const auto parse = [&](const char* key, GdkRGBA* color) {
      if (!merged.contains(key)) return;
      if (!merged[key].is_string() || merged[key].get_ref<const std::string&>().size() > 256 ||
          !gdk_rgba_parse(color, merged[key].get_ref<const std::string&>().c_str())) throw std::runtime_error(std::string("Invalid overlay ") + key);
    };
    parse("color", &background);
    const auto linear = [](double channel) { return channel <= 0.04045 ? channel / 12.92 : std::pow((channel + 0.055) / 1.055, 2.4); };
    const double luminance = 0.2126 * linear(background.red) + 0.7152 * linear(background.green) + 0.0722 * linear(background.blue);
    if (1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05) symbol = {1, 1, 1, 1};
    parse("symbolColor", &symbol);
    options_ = std::move(merged); height_ = height; background_ = background; symbol_ = symbol;
  }
  void Restyle() {
    gchar* color = gdk_rgba_to_string(&background_);
    const std::string css = std::string("#weber-window-control { padding: 0; margin: 0; border: none; border-radius: 0; min-width: 0; min-height: 0; box-shadow: none; transition-duration: 0s; background-image: none; background-color: ") + color + "; }\n"
      "#weber-window-control:hover { background-image: linear-gradient(rgba(127,127,127,0.2),rgba(127,127,127,0.2)); }";
    g_free(color);
    auto* provider = gtk_css_provider_new();
    gtk_css_provider_load_from_data(provider, css.c_str(), -1, nullptr);
    for (auto* button : buttons_) {
      if (provider_) gtk_style_context_remove_provider(gtk_widget_get_style_context(button), GTK_STYLE_PROVIDER(provider_));
      gtk_style_context_add_provider(gtk_widget_get_style_context(button), GTK_STYLE_PROVIDER(provider), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
      gtk_widget_set_size_request(button, 46, height_);
    }
    if (provider_) g_object_unref(provider_);
    provider_ = provider;
    gtk_widget_queue_draw(controls_);
  }
  GtkWidget* window_;
  GtkWidget* controls_ = nullptr;
  std::array<GtkWidget*, 3> buttons_{};
  GtkCssProvider* provider_ = nullptr;
  Action action_;
  std::array<bool, 3> enabled_;
  const char* names_[3] = {"Minimize", "Maximize or restore", "Close"};
  Json options_ = Json::object();
  GdkRGBA background_{}, symbol_{};
  int height_ = 32;
};
}

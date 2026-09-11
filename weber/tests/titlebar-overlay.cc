// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "../../shell/browser/obscura/desktop/titlebar_overlay.h"
#include <iostream>
#include <vector>
using Json = nlohmann::json;
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void Settle() {
  const auto end = g_get_monotonic_time() + 100000;
  do { while (g_main_context_iteration(nullptr, FALSE)) {} g_usleep(1000); } while (g_get_monotonic_time() < end);
}
int main(int argc, char** argv) {
  gtk_init(&argc, &argv);
  auto* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_decorated(GTK_WINDOW(window), FALSE);
  gtk_window_set_default_size(GTK_WINDOW(window), 500, 300);
  auto* overlay = gtk_overlay_new(); auto* content = gtk_drawing_area_new();
  gtk_container_add(GTK_CONTAINER(window), overlay); gtk_container_add(GTK_CONTAINER(overlay), content);
  std::vector<std::string> actions;
  {
    weber::desktop::TitleBarOverlay bar(window, overlay, {{"color", "#112233"}, {"symbolColor", "#ffffff"}, {"height", 29}}, true, true, true,
      [&](const std::string& action) { actions.push_back(action); });
    gtk_widget_show_all(window); Settle();
    auto state = bar.Describe();
    Check(state["controls"]["width"] == 138 && state["controls"]["height"] == 29, "native initial geometry");
    Check(gtk_widget_get_allocated_width(content) == 500 && gtk_widget_get_allocated_height(content) == 300, "overlay must not shrink content");
    auto pixels = [&]() {
      const auto geometry = bar.Describe()["controls"];
      auto* pixbuf = gdk_pixbuf_get_from_window(gtk_widget_get_window(window), geometry["x"].get<int>() + 4, geometry["y"].get<int>() + 4, 1, 1);
      Check(pixbuf != nullptr, "native pixels available");
      const auto* pixel = gdk_pixbuf_get_pixels(pixbuf);
      const int rgb = (pixel[0] << 16) | (pixel[1] << 8) | pixel[2]; g_object_unref(pixbuf); return rgb;
    };
    Check(pixels() == 0x112233, "initial native background pixels");
    bar.Update({{"height", 44}, {"color", "#aabbcc"}}); Settle();
    state = bar.Describe();
    const auto updated_pixel = pixels();
    std::cerr << "updated-state=" << state.dump() << " pixel=" << std::hex << updated_pixel << std::dec << std::endl;
    Check(state["controls"]["height"] == 44, "updated geometry");
    Check(updated_pixel == 0xaabbcc, "updated native background pixels");
    Check(state["symbolColor"] == "rgb(255,255,255)", "partial update preserves symbol color");
    try { bar.Update({{"height", 55}, {"color", "not-a-color"}}); throw std::logic_error("accepted bad color"); }
    catch (const std::runtime_error&) {}
    Check(bar.Describe() == state, "invalid update must be atomic");
    auto* children = gtk_container_get_children(GTK_CONTAINER(overlay));
    auto* controls = GTK_WIDGET(g_list_last(children)->data); g_list_free(children);
    auto* buttons = gtk_container_get_children(GTK_CONTAINER(controls));
    for (auto* item = buttons; item; item = item->next) gtk_button_clicked(GTK_BUTTON(item->data));
    g_list_free(buttons);
    Check(actions == std::vector<std::string>({"minimize", "maximize", "close"}), "native button actions");
    Check(gtk_widget_get_allocated_height(content) == 300, "updates preserve content allocation");
  }
  // Repeated construction/destruction on a surviving window must not retain
  // old control widgets, style providers or window-state callbacks.
  for (int i = 0; i < 20; ++i) {
    weber::desktop::TitleBarOverlay bar(window, overlay, {{"color", "#ffffff"}}, false, false, false, [](const std::string&) {});
    Check(bar.Describe()["symbolColor"] == "rgb(0,0,0)", "automatic contrasting symbols");
  }
  gtk_widget_destroy(window); Settle();
  std::cout << "{\"kind\":\"native-titlebar-overlay\",\"passed\":true,\"checks\":[\"geometry\",\"native-pixels\",\"partial-update\",\"invalid-rollback\",\"button-actions\",\"content-size\",\"lifecycle\"]}" << std::endl;
}

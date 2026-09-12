// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "../../shell/browser/obscura/desktop/menu.h"
#include <cassert>
#include <iostream>

int main(int argc, char** argv) {
  gtk_init(&argc, &argv);
  using Json = nlohmann::json;
  auto* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  auto* box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  gtk_container_add(GTK_CONTAINER(window), box);
  unsigned activations = 0;
  {
    weber::desktop::MenuView view(window, box, 1, [&](Json event) {
      if (event.value("event", "") == "menu-click") ++activations;
    });
    Json item = {{"menuId", 1}, {"commandId", 1}, {"type", "normal"}, {"label", "Count"},
      {"enabled", true}, {"visible", true}, {"checked", false}, {"accelerator", "Ctrl+K"}};
    Json menu = {{"menuId", 1}, {"items", Json::array({item})}};
    view.Set(menu); gtk_widget_show_all(window);
    view.SetVisible(false);
    gtk_accel_groups_activate(G_OBJECT(window), GDK_KEY_k, GDK_CONTROL_MASK);
    assert(activations == 1);
    assert(view.Describe().at("barVisible") == false);
    menu["items"][0]["enabled"] = false;
    view.Update(menu);
    gtk_accel_groups_activate(G_OBJECT(window), GDK_KEY_k, GDK_CONTROL_MASK);
    assert(activations == 1);
    view.Set(nullptr);
    gtk_accel_groups_activate(G_OBJECT(window), GDK_KEY_k, GDK_CONTROL_MASK);
    assert(activations == 1);
  }
  gtk_widget_destroy(window);
  std::cout << "{\"kind\":\"native-menubar-accelerator\",\"passed\":true,\"checks\":[\"hidden-bar\",\"disabled-command\",\"detached-menu\"]}\n";
}

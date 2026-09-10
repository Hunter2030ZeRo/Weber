// Copyright Weber contributors. SPDX-License-Identifier: MIT
// Exercises real GtkSettings -> platform notification and the synchronous wire.
#include "../../shell/browser/obscura/desktop/platform_sync.h"
#include "../../shell/browser/obscura/desktop/platform_wire.h"
#include <gtk/gtk.h>
#include <cstdlib>
#include <future>
#include <iostream>
#include <vector>

using Json = nlohmann::json;
namespace wire = weber::platform_wire;
using namespace std::chrono_literals;
void Check(bool ok, const char* reason) { if (!ok) throw std::runtime_error(reason); }
void Drain() { while (g_main_context_iteration(nullptr, FALSE)) {} }
Json Request(int socket, unsigned id, const std::string& method) {
  auto reply = std::async(std::launch::async, [=] {
    const auto deadline = wire::Clock::now() + 3s;
    wire::Write(socket, Json({{"id", id}, {"method", method}}).dump(), deadline);
    return Json::parse(wire::Read(socket, deadline));
  });
  while (reply.wait_for(1ms) != std::future_status::ready) Drain();
  const auto value = reply.get();
  Check(value.at("id") == id, "Native response id mismatch");
  if (value.contains("error")) throw std::runtime_error(value.at("error").get<std::string>());
  return value.at("result");
}
int main() {
  try {
    // Reserve the inherited descriptor before GTK opens its display sockets.
    int sockets[2];
    Check(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0, "Cannot create platform socket");
    const int peer = fcntl(sockets[1], F_DUPFD_CLOEXEC, 4);
    Check(peer >= 4, "Cannot reserve client socket");
    close(sockets[1]);
    Check(dup2(sockets[0], 3) == 3, "Cannot install platform descriptor");
    if (sockets[0] != 3) close(sockets[0]);
    Check(setenv("WEBER_PLATFORM_FD", "3", 1) == 0, "Cannot set platform descriptor");
    unsetenv("GTK_THEME");
    Check(gtk_init_check(nullptr, nullptr), "No GTK display");
    auto* settings = gtk_settings_get_default();
    g_object_set(settings, "gtk-theme-name", "Adwaita", "gtk-application-prefer-dark-theme", FALSE, nullptr);
    Drain();
    std::vector<Json> events;
    auto platform = weber::desktop::PlatformSync::FromEnvironment([&](Json value) { events.push_back(std::move(value)); });
    const auto theme_events = [&] {
      size_t count = 0;
      for (const auto& event : events) if (event.value("event", "") == "native-theme-updated") ++count;
      return count;
    };
    auto initial = Request(peer, 1, "nativeTheme.snapshot");
    Check(initial.at("themeSource") == "system", "Default theme source is not system");
    Check(initial.at("shouldUseDarkColors") == false, "Adwaita light was reported dark");
    Check(initial.at("shouldUseHighContrastColors") == false, "Adwaita was reported high contrast");
    Check(theme_events() == 0, "Snapshot query emitted a spurious change");
    g_object_set(settings, "gtk-application-prefer-dark-theme", TRUE, nullptr);
    Drain();
    const auto dark = Request(peer, 2, "nativeTheme.snapshot");
    Check(dark.at("shouldUseDarkColors") == true, "Actual Adwaita dark variant was not observed");
    Check(dark.at("shouldUseDarkColorsForSystemIntegratedUI") == true, "Native UI theme disagrees");
    Check(theme_events() == 1, "GTK dark transition did not emit exactly one native update");
    g_object_set(settings, "gtk-application-prefer-dark-theme", TRUE, nullptr);
    Drain();
    Check(theme_events() == 1, "Unchanged GTK policy emitted duplicate update");
    g_object_set(settings, "gtk-theme-name", "HighContrast", "gtk-application-prefer-dark-theme", FALSE, nullptr);
    Drain();
    const auto contrast = Request(peer, 3, "nativeTheme.snapshot");
    Check(contrast.at("shouldUseHighContrastColors") == true, "GTK high contrast was not observed");
    Check(theme_events() >= 2, "GTK high contrast transition emitted no update");
    Check(contrast.at("inForcedColorsMode") == false, "GTK theme must not claim renderer forced colors");
    Check(contrast.at("shouldUseInvertedColorScheme") == false, "GTK theme must not claim display inversion");
    const auto before = theme_events();
    g_object_set(settings, "gtk-theme-name", "Adwaita", nullptr);
    Drain();
    Check(Request(peer, 4, "nativeTheme.snapshot") == initial, "System appearance did not restore");
    Check(theme_events() > before, "Appearance restore did not notify");
    platform.reset();
    close(peer);
    std::cout << Json({{"kind", "native-theme-acceptance"}, {"ok", true},
      {"checked", {"GTK light and dark variants", "high contrast and restore", "deduplicated notifications", "real synchronous platform wire"}}}).dump() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}

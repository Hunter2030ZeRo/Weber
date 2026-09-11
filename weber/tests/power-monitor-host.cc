// Copyright Weber contributors. SPDX-License-Identifier: MIT
// Uses the production synchronous platform channel and power implementation,
// without linking the renderer engine, for fast protocol regression tests.
#include "../../shell/browser/obscura/desktop/platform_sync.h"
#include <gtk/gtk.h>
#include <iostream>
#include <unistd.h>
int main(int argc, char** argv) {
  gtk_init(&argc, &argv);
  auto platform = weber::desktop::PlatformSync::FromEnvironment([](nlohmann::json event) {
    std::cout << event.dump() << std::endl;
  });
  if (!platform) return 2;
  auto* input = g_io_channel_unix_new(STDIN_FILENO);
  g_io_add_watch(input, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR),
    +[](GIOChannel* channel, GIOCondition condition, gpointer) -> gboolean {
      if (condition & (G_IO_HUP | G_IO_ERR)) { gtk_main_quit(); return G_SOURCE_REMOVE; }
      gchar* line = nullptr;
      const auto status = g_io_channel_read_line(channel, &line, nullptr, nullptr, nullptr);
      g_free(line);
      if (status == G_IO_STATUS_EOF) { gtk_main_quit(); return G_SOURCE_REMOVE; }
      return G_SOURCE_CONTINUE;
    }, nullptr);
  gtk_main();
  platform.reset();
  g_io_channel_unref(input);
}

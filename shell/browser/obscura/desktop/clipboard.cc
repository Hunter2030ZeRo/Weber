// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "clipboard.h"
#include <gtk/gtk.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
namespace weber::desktop {
namespace {
using Json = nlohmann::json;
constexpr size_t kClipboardLimit = 2 * 1024 * 1024;
struct Read {
  GMainLoop* loop = g_main_loop_new(nullptr, FALSE);
  bool done = false;
  bool timed_out = false;
  Json result = nullptr;
  std::string error;
  ~Read() { g_main_loop_unref(loop); }
};
Json ReadTarget(GtkClipboard* clipboard, const std::string& target) {
  auto state = std::make_shared<Read>();
  const guint timer = g_timeout_add(3000, [](gpointer p) -> gboolean {
    static_cast<Read*>(p)->timed_out = true;
    g_main_loop_quit(static_cast<Read*>(p)->loop); return G_SOURCE_REMOVE;
  }, state.get());
  gtk_clipboard_request_contents(clipboard, gdk_atom_intern(target.c_str(), FALSE),
    [](GtkClipboard*, GtkSelectionData* data, gpointer pointer) {
      std::unique_ptr<std::shared_ptr<Read>> owner(static_cast<std::shared_ptr<Read>*>(pointer));
      auto& state = **owner;
      try {
        const int length = gtk_selection_data_get_length(data);
        if (length > static_cast<int>(kClipboardLimit)) throw std::runtime_error("Clipboard exceeds 2 MiB");
        if (gtk_selection_data_get_target(data) == gdk_atom_intern_static_string("TARGETS")) {
          GdkAtom* atoms = nullptr; int count = 0;
          state.result = Json::array();
          if (gtk_selection_data_get_targets(data, &atoms, &count)) {
            if (count <= 256) for (int i = 0; i < count; ++i) {
              gchar* name = gdk_atom_name(atoms[i]);
              if (name) { state.result.push_back(name); g_free(name); }
            }
            g_free(atoms);
            if (count > 256) throw std::runtime_error("Too many clipboard formats");
          }
        } else if (length >= 0) {
          gchar* encoded = g_base64_encode(gtk_selection_data_get_data(data), static_cast<size_t>(length));
          state.result = encoded; g_free(encoded);
        }
      } catch (const std::exception& e) { state.error = e.what(); }
      state.done = true; g_main_loop_quit(state.loop);
    }, new std::shared_ptr<Read>(state));
  if (!state->done) g_main_loop_run(state->loop);
  // A synchronous owner callback can finish before entering the nested loop.
  if (!state->timed_out) g_source_remove(timer);
  if (!state->done) throw std::runtime_error("Clipboard owner did not respond within three seconds");
  if (!state->error.empty()) throw std::runtime_error(state->error);
  return state->result;
}
struct Entry { std::string format; std::vector<guchar> bytes; };
struct Contents { std::vector<Entry> entries; };
}
Json Clipboard(const Json& request) {
  const auto selection = request.value("selection", "clipboard");
  if (selection != "clipboard" && selection != "selection") throw std::runtime_error("Invalid clipboard selection");
  auto* clipboard = gtk_clipboard_get(selection == "selection" ? GDK_SELECTION_PRIMARY : GDK_SELECTION_CLIPBOARD);
  const auto method = request.at("method").get<std::string>();
  if (method == "clipboard.clear") { gtk_clipboard_clear(clipboard); return nullptr; }
  if (method == "clipboard.formats") return ReadTarget(clipboard, "TARGETS");
  if (method == "clipboard.read") {
    const auto format = request.at("format").get<std::string>();
    if (format.empty() || format.size() > 256 || format.find('\0') != std::string::npos)
      throw std::runtime_error("Invalid clipboard format");
    return ReadTarget(clipboard, format);
  }
  if (method != "clipboard.write") throw std::runtime_error("Unsupported clipboard operation");
  const auto& items = request.at("items");
  if (!items.is_array() || items.empty() || items.size() > 64) throw std::runtime_error("Invalid clipboard entries");
  auto data = std::make_unique<Contents>();
  size_t total = 0;
  for (const auto& item : items) {
    Entry entry; entry.format = item.at("format").get<std::string>();
    if (entry.format.empty() || entry.format.size() > 256 || entry.format.find('\0') != std::string::npos)
      throw std::runtime_error("Invalid clipboard format");
    const auto encoded = item.at("data").get<std::string>();
    if (encoded.size() > (kClipboardLimit + 2) / 3 * 4) throw std::runtime_error("Clipboard exceeds 2 MiB");
    gsize length = 0; guchar* bytes = g_base64_decode(encoded.c_str(), &length);
    if (length) entry.bytes.assign(bytes, bytes + length);
    g_free(bytes); total += length;
    if (total > kClipboardLimit) throw std::runtime_error("Clipboard exceeds 2 MiB");
    data->entries.push_back(std::move(entry));
  }
  std::vector<GtkTargetEntry> targets;
  for (size_t i = 0; i < data->entries.size(); ++i)
    targets.push_back({const_cast<gchar*>(data->entries[i].format.c_str()), 0, static_cast<guint>(i)});
  const bool owned = gtk_clipboard_set_with_data(clipboard, targets.data(), targets.size(),
    [](GtkClipboard*, GtkSelectionData* selection, guint info, gpointer pointer) {
      const auto& entries = static_cast<Contents*>(pointer)->entries;
      if (info >= entries.size()) return;
      const auto& entry = entries[info];
      gtk_selection_data_set(selection, gtk_selection_data_get_target(selection), 8, entry.bytes.data(), entry.bytes.size());
    }, [](GtkClipboard*, gpointer pointer) { delete static_cast<Contents*>(pointer); }, data.get());
  if (!owned) throw std::runtime_error("Cannot claim system clipboard");
  data.release();
  return nullptr;
}
}

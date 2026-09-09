// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
#ifndef WEBER_DESKTOP_PLATFORM_SYNC_H_
#define WEBER_DESKTOP_PLATFORM_SYNC_H_
#include <nlohmann/json.hpp>
#include <functional>
#include <memory>
namespace weber::desktop {
// Owns a private inherited Unix socket. GTK operations run only on the main
// loop; the reader thread frames requests and sends bounded responses.
class PlatformSync {
 public:
  using Emit = std::function<void(nlohmann::json)>;
  static std::unique_ptr<PlatformSync> FromEnvironment(Emit emit);
  ~PlatformSync();
  PlatformSync(const PlatformSync&) = delete;
  PlatformSync& operator=(const PlatformSync&) = delete;
 private:
  struct State;
  explicit PlatformSync(std::unique_ptr<State> state);
  std::unique_ptr<State> state_;
};
}  // namespace weber::desktop
#endif

// Copyright Weber contributors. SPDX-License-Identifier: Apache-2.0
#ifndef WEBER_OBSCURA_ENGINE_H_
#define WEBER_OBSCURA_ENGINE_H_
#include <cstdint>
#include <string>
#include <thread>
#include <vector>
namespace electron::obscura {
// First engine boundary for the replacement renderer. No Chromium headers.
// A dedicated process will own this adapter; BrowserWindow routing is pending.
class ObscuraEngine final {
 public:
  explicit ObscuraEngine(int resource_fd = -1);
  ~ObscuraEngine();
  ObscuraEngine(const ObscuraEngine&) = delete;
  ObscuraEngine& operator=(const ObscuraEngine&) = delete;
  std::vector<uint8_t> Command(const std::string& json);
  int Wait(int fd, bool watch_frames);
 private:
  uint64_t handle_;
  std::thread::id owner_;
};
}
#endif

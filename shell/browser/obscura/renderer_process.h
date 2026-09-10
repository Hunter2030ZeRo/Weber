// SPDX-License-Identifier: Apache-2.0
#ifndef WEBER_RENDERER_PROCESS_H_
#define WEBER_RENDERER_PROCESS_H_
#include <chrono>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>
namespace electron::obscura {
// Linux initial transport. Own on a browser-side worker/task runner, never the
// GUI thread: startup and Command wait for a bounded response. No V8 dependency.
class RendererProcess final {
 public:
  explicit RendererProcess(const std::string& executable,
                           std::chrono::milliseconds timeout = std::chrono::seconds(30), int resource_fd = -1);
  ~RendererProcess();
  RendererProcess(const RendererProcess&) = delete;
  RendererProcess& operator=(const RendererProcess&) = delete;
  std::vector<uint8_t> Command(const std::string& json);
  int process_id() const { return pid_; }
 private:
  void Stop() noexcept;
  int fd_ = -1;
  int pid_ = -1;
  uint32_t sequence_ = 0;
  std::chrono::milliseconds timeout_;
  std::thread::id owner_;
};
}
#endif

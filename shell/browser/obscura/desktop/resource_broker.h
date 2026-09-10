// Copyright Weber contributors. SPDX-License-Identifier: MIT
#pragma once
#include <nlohmann/json.hpp>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>
namespace weber::desktop {
// Private renderer-to-main resource channel. Never listens on a network port.
class ResourceBroker {
 public:
  using Json = nlohmann::json;
  explicit ResourceBroker(std::function<void(const Json&)> emit);
  ~ResourceBroker();
  int child_fd() const { return child_; }
  void ChildSpawned();
  void Resolve(uint32_t id, Json response);
  void Cancel();
 private:
  void Run();
  int parent_ = -1, child_ = -1;
  std::function<void(const Json&)> emit_;
  std::atomic<bool> stopped_{false};
  std::mutex mutex_;
  std::condition_variable wake_;
  uint32_t pending_ = 0;
  Json response_;
  bool resolved_ = false;
  std::thread reader_;
};
}

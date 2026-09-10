// Copyright Weber contributors. SPDX-License-Identifier: MIT
#pragma once
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
namespace weber::desktop {
class PowerMonitor {
 public:
  explicit PowerMonitor(std::function<void(nlohmann::json)> emit);
  ~PowerMonitor();
  nlohmann::json Command(const nlohmann::json& request);
 private:
  struct State;
  std::unique_ptr<State> state_;
};
}

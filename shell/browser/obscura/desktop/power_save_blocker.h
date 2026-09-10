// Copyright Weber contributors. SPDX-License-Identifier: MIT
#pragma once
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
namespace weber::desktop {
class PowerSaveBlocker {
 public:
  explicit PowerSaveBlocker(std::function<void(nlohmann::json)> emit);
  ~PowerSaveBlocker();
  nlohmann::json Command(const nlohmann::json& request);
 private:
  struct State;
  std::unique_ptr<State> state_;
};
}

// Copyright Weber contributors. SPDX-License-Identifier: MIT
#pragma once
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
namespace weber::desktop {
class NotificationCenter {
 public:
  explicit NotificationCenter(std::function<void(nlohmann::json)> emit);
  ~NotificationCenter();
  nlohmann::json Command(const nlohmann::json& request);
 private:
  struct State;
  std::shared_ptr<State> state_;
};
}

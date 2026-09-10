// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
#ifndef WEBER_DESKTOP_ASYNC_OUTPUT_H_
#define WEBER_DESKTOP_ASYNC_OUTPUT_H_

#include <chrono>
#include <cstddef>
#include <functional>
#include <memory>
#include <string>

namespace weber::desktop {
struct OutputLimits {
  // Includes the frame currently being written, not just waiting messages.
  size_t bytes = 96 * 1024 * 1024;
  size_t messages = 1024;
  std::chrono::milliseconds delivery_timeout{30000};
  std::chrono::milliseconds shutdown_timeout{2000};
};

// Takes ownership of fd, including on construction failure. A small socket
// message may be sent inline only when no earlier message is in flight. One
// writer drains the bounded FIFO; producers never wait for the receiver.
// Overflow, broken pipes and deadlines permanently fail the stream and invoke
// on_failure once. The owner must close the host, rejecting outstanding RPCs.
class AsyncOutput {
 public:
  AsyncOutput(int fd, std::function<void()> on_failure, OutputLimits limits = {});
  ~AsyncOutput();
  AsyncOutput(const AsyncOutput&) = delete;
  AsyncOutput& operator=(const AsyncOutput&) = delete;
  bool Enqueue(std::string message);
  // Stop accepting messages and drain under one bounded shutdown deadline.
  // Safe alongside Enqueue. Returns false if the stream could not be delivered.
  bool Finish();

 private:
  struct State;
  std::unique_ptr<State> state_;
};
}  // namespace weber::desktop
#endif

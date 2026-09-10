// SPDX-License-Identifier: Apache-2.0
#ifndef WEBER_OBSCURA_WIRE_H_
#define WEBER_OBSCURA_WIRE_H_
#include <chrono>
#include <cstdint>
#include <vector>
namespace electron::obscura::wire {
using Deadline = std::chrono::steady_clock::time_point;
constexpr uint32_t kRequest = 0, kSuccess = 1, kError = 2, kReady = 3, kEvents = 4, kFrameReady = 5;
constexpr uint32_t kMaxRequest = 1024 * 1024, kMaxResponse = 64 * 1024 * 1024;
struct Frame { uint32_t sequence; uint32_t kind; std::vector<uint8_t> payload; };
void Send(int fd, const Frame& frame, Deadline deadline);
Frame Receive(int fd, uint32_t max_size, Deadline deadline);
}
#endif

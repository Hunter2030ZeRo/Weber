// SPDX-License-Identifier: Apache-2.0
#include "wire.h"
#include <algorithm>
#include <array>
#include <cerrno>
#include <climits>
#include <cstring>
#include <poll.h>
#include <stdexcept>
#include <sys/socket.h>
namespace electron::obscura::wire {
namespace {
void Transfer(int fd, uint8_t* data, size_t size, bool write, Deadline deadline) {
  while (size) {
    int timeout = -1;
    if (deadline != Deadline::max()) {
      const auto left = deadline - std::chrono::steady_clock::now();
      if (left <= Deadline::duration::zero()) throw std::runtime_error("Renderer deadline exceeded");
      const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(left).count();
      timeout = static_cast<int>(std::min<int64_t>(INT_MAX, ms + 1));
    }
    pollfd poll_fd{fd, static_cast<short>(write ? POLLOUT : POLLIN), 0};
    const int ready = poll(&poll_fd, 1, timeout);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) throw std::runtime_error("Renderer poll failed");
    if (ready == 0) throw std::runtime_error("Renderer deadline exceeded");
    const ssize_t count = write ? send(fd, data, size, MSG_NOSIGNAL | MSG_DONTWAIT)
                                : recv(fd, data, size, MSG_DONTWAIT);
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (count <= 0) throw std::runtime_error("Renderer channel disconnected");
    data += count; size -= static_cast<size_t>(count);
  }
}
void Put(uint8_t* p, uint32_t value) {
  for (int i = 3; i >= 0; --i) { p[i] = static_cast<uint8_t>(value); value >>= 8; }
}
uint32_t Get(const uint8_t* p) {
  return (uint32_t{p[0]} << 24) | (uint32_t{p[1]} << 16) | (uint32_t{p[2]} << 8) | p[3];
}
}
void Send(int fd, const Frame& frame, Deadline deadline) {
  if (frame.payload.size() > kMaxResponse) throw std::runtime_error("Renderer response too large");
  std::array<uint8_t, 16> header{'W','B','R','1'};
  Put(header.data() + 4, frame.sequence); Put(header.data() + 8, frame.kind);
  Put(header.data() + 12, static_cast<uint32_t>(frame.payload.size()));
  Transfer(fd, header.data(), header.size(), true, deadline);
  // send() does not mutate its buffer; Transfer shares the read/write loop.
  Transfer(fd, const_cast<uint8_t*>(frame.payload.data()), frame.payload.size(), true, deadline);
}
Frame Receive(int fd, uint32_t max_size, Deadline deadline) {
  std::array<uint8_t, 16> header{};
  Transfer(fd, header.data(), header.size(), false, deadline);
  if (std::memcmp(header.data(), "WBR1", 4)) throw std::runtime_error("Invalid renderer protocol");
  const uint32_t size = Get(header.data() + 12);
  if (size > max_size) throw std::runtime_error("Renderer frame exceeds limit");
  Frame frame{Get(header.data() + 4), Get(header.data() + 8), std::vector<uint8_t>(size)};
  Transfer(fd, frame.payload.data(), size, false, deadline);
  return frame;
}
}

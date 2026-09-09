// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
#ifndef WEBER_DESKTOP_PLATFORM_WIRE_H_
#define WEBER_DESKTOP_PLATFORM_WIRE_H_
#include <sys/socket.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <string>

namespace weber::platform_wire {
using Clock = std::chrono::steady_clock;
constexpr size_t kLimit = 64 * 1024;
inline void Nonblocking(int fd) {
  const int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
    throw std::runtime_error("Cannot configure platform socket");
}
inline void Wait(int fd, short events, Clock::time_point deadline) {
  while (true) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    if (remaining <= 0) throw std::runtime_error("Synchronous platform request timed out");
    pollfd item{fd, events, 0};
    const int result = poll(&item, 1, static_cast<int>(remaining));
    if (result < 0 && errno == EINTR) continue;
    if (result < 0) throw std::runtime_error("Platform socket poll failed");
    if (result == 0) continue;
    if (item.revents & events) return;
    throw std::runtime_error("Platform socket closed");
  }
}
inline void Transfer(int fd, char* bytes, size_t size, bool writing, Clock::time_point deadline) {
  size_t offset = 0;
  while (offset != size) {
    Wait(fd, writing ? POLLOUT : POLLIN, deadline);
    const auto count = writing ? send(fd, bytes + offset, size - offset, MSG_NOSIGNAL) :
        recv(fd, bytes + offset, size - offset, 0);
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (count <= 0) throw std::runtime_error("Platform socket closed during frame");
    offset += static_cast<size_t>(count);
  }
}
inline void Write(int fd, const std::string& bytes, Clock::time_point deadline) {
  if (bytes.empty() || bytes.size() > kLimit) throw std::runtime_error("Platform frame exceeds 64 KiB");
  const uint32_t size = static_cast<uint32_t>(bytes.size());
  char header[4];
  for (unsigned i = 0; i < 4; ++i) header[i] = static_cast<char>(size >> (i * 8));
  Transfer(fd, header, 4, true, deadline);
  Transfer(fd, const_cast<char*>(bytes.data()), bytes.size(), true, deadline);
}
inline std::string Read(int fd, Clock::time_point deadline) {
  char header[4];
  Transfer(fd, header, 4, false, deadline);
  uint32_t size = 0;
  for (unsigned i = 0; i < 4; ++i) size |= uint32_t(static_cast<unsigned char>(header[i])) << (i * 8);
  if (!size || size > kLimit) throw std::runtime_error("Invalid platform frame length");
  std::string result(size, '\0');
  Transfer(fd, result.data(), result.size(), false, deadline);
  return result;
}
}  // namespace weber::platform_wire
#endif

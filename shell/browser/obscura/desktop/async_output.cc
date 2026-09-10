// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
#include "async_output.h"
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <unistd.h>
#include <algorithm>
#include <cerrno>
#include <climits>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace weber::desktop {
namespace {
struct Descriptor {
  int value;
  explicit Descriptor(int fd) : value(fd) {}
  Descriptor(Descriptor&& other) noexcept : value(std::exchange(other.value, -1)) {}
  ~Descriptor() { Reset(); }
  void Reset() {
    if (value >= 0) { close(value); value = -1; }
  }
  Descriptor(const Descriptor&) = delete;
  Descriptor& operator=(const Descriptor&) = delete;
};
}  // namespace

struct AsyncOutput::State {
  using Clock = std::chrono::steady_clock;
  struct Message { std::string bytes; Clock::time_point deadline; };
  Descriptor fd;
  Descriptor signal;
  std::function<void()> on_failure;
  OutputLimits limits;
  std::mutex mutex;
  std::mutex finish_mutex;
  std::condition_variable wake;
  std::deque<Message> queue;
  size_t pending_bytes = 0;
  size_t pending_messages = 0;
  bool accepting = true;
  bool failed = false;
  bool stream_socket = false;
  Clock::time_point drain_deadline = Clock::time_point::max();
  std::thread writer;

  State(Descriptor descriptor, std::function<void()> callback, OutputLimits bounds)
      : fd(std::move(descriptor)), signal(eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC)),
        on_failure(std::move(callback)), limits(bounds) {
    if (fd.value < 0 || signal.value < 0 || !limits.bytes || !limits.messages ||
        limits.delivery_timeout.count() <= 0 || limits.shutdown_timeout.count() <= 0)
      throw std::runtime_error("Invalid desktop output configuration");
    const int flags = fcntl(fd.value, F_GETFL);
    if (flags < 0 || fcntl(fd.value, F_SETFL, flags | O_NONBLOCK) < 0 ||
        fcntl(fd.value, F_SETFD, FD_CLOEXEC) < 0)
      throw std::runtime_error("Cannot configure desktop output descriptor");
    int socket_type = 0; socklen_t socket_length = sizeof(socket_type);
    stream_socket = getsockopt(fd.value, SOL_SOCKET, SO_TYPE, &socket_type, &socket_length) == 0 && socket_type == SOCK_STREAM;
    writer = std::thread([this] { Run(); });
  }
  ~State() { Finish(); }

  // Called with mutex held so Finish cannot close/reuse the wake descriptor
  // between its ownership check and the write. eventfd is never a blocking pipe.
  void Notify() {
    const uint64_t value = 1;
    while (write(signal.value, &value, sizeof(value)) < 0 && errno == EINTR) {}
    wake.notify_all();
  }
  void Fail() noexcept {
    bool notify = false;
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!failed) {
        failed = true; accepting = false;
        queue.clear(); pending_bytes = 0; pending_messages = 0;
        Notify(); notify = true;
      }
    }
    // Failure is an out-of-band host shutdown, never another stdout message.
    if (notify && on_failure) { try { on_failure(); } catch (...) {} }
  }
  bool Enqueue(std::string bytes) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!accepting || failed) return false;
      if (!bytes.empty() && bytes.size() <= limits.bytes - pending_bytes &&
          pending_messages < limits.messages) {
        // libuv child stdio is a Unix stream socket on Linux. When no writer
        // owns earlier bytes, send a small reply without another thread hop.
        // MSG_DONTWAIT never waits for the receiver; MSG_NOSIGNAL protects
        // every producer thread without changing the process signal policy.
        if (stream_socket && !pending_messages && bytes.size() <= 16 * 1024) {
          const auto written = send(fd.value, bytes.data(), bytes.size(), MSG_DONTWAIT | MSG_NOSIGNAL);
          if (written == static_cast<ssize_t>(bytes.size())) return true;
          if (written > 0) bytes.erase(0, static_cast<size_t>(written));
          // A partial/full-buffer send joins the same bounded FIFO. A broken
          // stream is handled by the writer's existing permanent-failure path.
        }
        const size_t size = bytes.size();
        queue.push_back({std::move(bytes), Clock::now() + limits.delivery_timeout});
        pending_bytes += size; ++pending_messages;
        Notify();
        return true;
      }
    }
    Fail();
    return false;
  }
  bool Write(const Message& message) {
    size_t offset = 0;
    while (offset != message.bytes.size()) {
      Clock::time_point deadline;
      {
        std::lock_guard<std::mutex> lock(mutex);
        if (failed) return false;
        deadline = std::min(message.deadline, drain_deadline);
      }
      const auto remaining = deadline - Clock::now();
      if (remaining <= Clock::duration::zero()) throw std::runtime_error("Desktop output deadline expired");
      const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(remaining).count();
      const int timeout = static_cast<int>(std::min<int64_t>(milliseconds + 1, INT_MAX));
      pollfd descriptors[] = {{fd.value, POLLOUT, 0}, {signal.value, POLLIN, 0}};
      const int ready = poll(descriptors, 2, timeout);
      if (ready < 0 && errno == EINTR) continue;
      if (ready < 0) throw std::runtime_error("Desktop output poll failed");
      if (!ready) continue;
      if (descriptors[1].revents & POLLIN) {
        uint64_t value;
        while (read(signal.value, &value, sizeof(value)) < 0 && errno == EINTR) {}
        continue;  // Re-read shutdown/failure state and its possibly earlier deadline.
      }
      if (!(descriptors[0].revents & POLLOUT)) throw std::runtime_error("Desktop output closed");
      const auto size = write(fd.value, message.bytes.data() + offset,
          std::min<size_t>(message.bytes.size() - offset, 64 * 1024));
      if (size < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
      if (size <= 0) throw std::runtime_error("Desktop output write failed");
      offset += static_cast<size_t>(size);
    }
    return true;
  }
  void Run() noexcept {
    try {
      // A disconnected pipe must fail the stream, not terminate the process
      // before the browser can close its windows and reap renderer children.
      sigset_t signals;
      sigemptyset(&signals); sigaddset(&signals, SIGPIPE);
      if (pthread_sigmask(SIG_BLOCK, &signals, nullptr) != 0)
        throw std::runtime_error("Cannot protect desktop output from SIGPIPE");
      while (true) {
        Message message;
        {
          std::unique_lock<std::mutex> lock(mutex);
          wake.wait(lock, [&] { return failed || !queue.empty() || !accepting; });
          if (failed || queue.empty()) return;
          message = std::move(queue.front()); queue.pop_front();
        }
        if (!Write(message)) return;
        {
          std::lock_guard<std::mutex> lock(mutex);
          if (failed) return;
          pending_bytes -= message.bytes.size(); --pending_messages;
        }
      }
    } catch (...) { Fail(); }
  }
  bool Finish() {
    std::lock_guard<std::mutex> finishing(finish_mutex);
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (accepting) {
        accepting = false;
        drain_deadline = Clock::now() + limits.shutdown_timeout;
        Notify();
      }
    }
    if (writer.joinable()) writer.join();
    std::lock_guard<std::mutex> lock(mutex);
    fd.Reset(); signal.Reset();
    return !failed;
  }
};
AsyncOutput::AsyncOutput(int fd, std::function<void()> on_failure, OutputLimits limits)
    : state_(std::make_unique<State>(Descriptor(fd), std::move(on_failure), limits)) {}
AsyncOutput::~AsyncOutput() = default;
bool AsyncOutput::Enqueue(std::string message) { return state_->Enqueue(std::move(message)); }
bool AsyncOutput::Finish() { return state_->Finish(); }
}  // namespace weber::desktop

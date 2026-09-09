// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
#include "../../shell/browser/obscura/desktop/async_output.h"
#include <fcntl.h>
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

using weber::desktop::AsyncOutput;
using weber::desktop::OutputLimits;
using namespace std::chrono_literals;
namespace {
void Check(bool value, const char* error) {
  if (!value) throw std::runtime_error(error);
}
struct Pipe {
  int reader = -1;
  int writer = -1;
  Pipe() {
    int pair[2];
    Check(pipe2(pair, O_CLOEXEC) == 0, "Cannot create output test pipe");
    reader = pair[0]; writer = pair[1];
    Check(fcntl(writer, F_SETPIPE_SZ, 4096) >= 4096, "Cannot set test pipe capacity");
  }
  ~Pipe() { if (reader >= 0) close(reader); if (writer >= 0) close(writer); }
  int TakeWriter() { return std::exchange(writer, -1); }
  std::string Fill() {
    const int size = fcntl(writer, F_GETPIPE_SZ);
    Check(size > 0, "Cannot read pipe capacity");
    std::string prefix(static_cast<size_t>(size), 'P');
    Check(write(writer, prefix.data(), prefix.size()) == size, "Cannot fill output pipe");
    return prefix;
  }
  std::string ReadAll() {
    std::string bytes; char buffer[4096];
    while (true) {
      const auto size = read(reader, buffer, sizeof(buffer));
      if (size < 0 && errno == EINTR) continue;
      Check(size >= 0, "Cannot read output pipe");
      if (!size) return bytes;
      bytes.append(buffer, static_cast<size_t>(size));
    }
  }
};

void BackpressurePreservesReplies() {
  Pipe pipe;
  const auto prefix = pipe.Fill(); // Receiver deliberately does not drain yet.
  std::atomic<unsigned> failures{0};
  OutputLimits limits; limits.bytes = 1024 * 1024; limits.delivery_timeout = 2s;
  AsyncOutput output(pipe.TakeWriter(), [&] { ++failures; }, limits);
  const std::string first = "{\"event\":\"large\",\"data\":\"" + std::string(128 * 1024, 'x') + "\"}\n";
  const std::string reply = "{\"id\":42,\"result\":\"한글\"}\n";
  const auto start = std::chrono::steady_clock::now();
  Check(output.Enqueue(first), "Cannot enqueue large event");
  Check(output.Enqueue(reply), "Cannot enqueue essential reply behind blocked stdout");
  Check(std::chrono::steady_clock::now() - start < 500ms,
        "Producer waited for a full stdout pipe; synchronous GTK service would deadlock");
  std::string received;
  std::thread consumer([&] { received = pipe.ReadAll(); });
  const bool finished = output.Finish();
  consumer.join();
  Check(finished && failures == 0, "Draining output unexpectedly failed");
  Check(received == prefix + first + reply, "Output bytes, FIFO order or essential reply were lost");
}

void QueueOverflowFailsClosed() {
  Pipe pipe; pipe.Fill();
  std::atomic<unsigned> failures{0};
  OutputLimits limits; limits.bytes = 128; limits.messages = 2;
  AsyncOutput output(pipe.TakeWriter(), [&] { ++failures; }, limits);
  Check(output.Enqueue(std::string(64, 'a')), "Cannot enqueue first bounded message");
  Check(output.Enqueue(std::string(64, 'b')), "Cannot enqueue second bounded message");
  Check(!output.Enqueue("c"), "In-flight frame was excluded from queue bounds");
  Check(!output.Enqueue("later"), "Failed output stream accepted a later reply");
  const auto start = std::chrono::steady_clock::now();
  Check(!output.Finish(), "Overflow must report failure, not silent message loss");
  Check(std::chrono::steady_clock::now() - start < 500ms, "Overflow did not wake blocked writer");
  Check(failures == 1, "Output failure callback must run exactly once");
}

void DeadlinesAreBounded(bool shutdown) {
  Pipe pipe; pipe.Fill();
  std::atomic<unsigned> failures{0};
  OutputLimits limits;
  limits.delivery_timeout = shutdown ? 3s : 80ms;
  limits.shutdown_timeout = shutdown ? 80ms : 2s;
  AsyncOutput output(pipe.TakeWriter(), [&] { ++failures; }, limits);
  Check(output.Enqueue("essential reply\n"), "Cannot enqueue deadline test reply");
  const auto start = std::chrono::steady_clock::now();
  Check(!output.Finish(), "Undelivered reply must fail at its deadline");
  Check(std::chrono::steady_clock::now() - start < 800ms,
        "Output shutdown or delivery deadline was not enforced");
  Check(failures == 1, "Deadline did not notify its owner exactly once");
}

void ClosedReceiverAndDescriptorOwnership() {
  Pipe pipe;
  close(pipe.reader); pipe.reader = -1;
  std::atomic<unsigned> failures{0};
  const int descriptor = pipe.writer;
  {
    AsyncOutput output(pipe.TakeWriter(), [&] { ++failures; });
    Check(output.Enqueue("reply\n"), "Cannot enqueue closed receiver test");
    Check(!output.Finish(), "Closed receiver must fail without SIGPIPE process termination");
    Check(failures == 1, "Closed receiver did not notify its owner");
    const int replacement = open("/dev/null", O_WRONLY | O_CLOEXEC);
    Check(replacement >= 0, "Cannot open replacement descriptor");
    if (replacement != descriptor) {
      Check(dup2(replacement, descriptor) == descriptor, "Cannot reuse released descriptor");
      close(replacement);
    }
  }
  Check(fcntl(descriptor, F_GETFD) >= 0, "Destructor closed a reused descriptor twice");
  close(descriptor);
}
}  // namespace
int main() {
  try {
    BackpressurePreservesReplies();
    QueueOverflowFailsClosed();
    DeadlinesAreBounded(false);
    DeadlinesAreBounded(true);
    ClosedReceiverAndDescriptorOwnership();
    std::cout << "Async desktop output: full-pipe progress, FIFO replies, bounds, deadlines, EOF and descriptor ownership passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}

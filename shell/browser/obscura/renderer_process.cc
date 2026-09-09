// SPDX-License-Identifier: Apache-2.0
#include "renderer_process.h"
#include "../../common/obscura/wire.h"
#include <cerrno>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <spawn.h>
#include <stdexcept>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
namespace electron::obscura {
RendererProcess::RendererProcess(const std::string& executable, std::chrono::milliseconds timeout)
    : timeout_(timeout), owner_(std::this_thread::get_id()) {
  if (timeout.count() <= 0 || executable.empty() || executable[0] != '/' || executable.find('\0') != std::string::npos)
    throw std::invalid_argument("Expected absolute renderer executable and positive deadline");
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) throw std::runtime_error("socketpair failed");
  // Keep the child endpoint above stdio even when the caller closed fd 0/1/2.
  const int child_endpoint = fcntl(pair[1], F_DUPFD_CLOEXEC, 4);
  if (child_endpoint < 0) { close(pair[0]); close(pair[1]); throw std::runtime_error("Renderer descriptor duplication failed"); }
  close(pair[1]); pair[1] = child_endpoint;
  posix_spawn_file_actions_t actions;
  int error = posix_spawn_file_actions_init(&actions);
  if (error) { close(pair[0]); close(pair[1]); throw std::runtime_error("spawn actions failed"); }
  // Close parent endpoint BEFORE dup2: it can itself be fd 3.
  error = posix_spawn_file_actions_addclose(&actions, pair[0]);
  if (!error) error = posix_spawn_file_actions_adddup2(&actions, pair[1], 3);
  if (!error) error = posix_spawn_file_actions_addclosefrom_np(&actions, 4);
  char channel[] = "--weber-channel=3";
  char* args[] = {const_cast<char*>(executable.c_str()), channel, nullptr};
  pid_t child = -1;
  if (!error) error = posix_spawn(&child, executable.c_str(), &actions, nullptr, args, environ);
  posix_spawn_file_actions_destroy(&actions);
  close(pair[1]);
  if (error) { close(pair[0]); throw std::runtime_error(std::string("Renderer spawn failed: ") + std::strerror(error)); }
  fd_ = pair[0]; pid_ = child;
  try {
    auto ready = wire::Receive(fd_, 16, std::chrono::steady_clock::now() + timeout_);
    if (ready.kind != wire::kReady || ready.sequence != 0 || ready.payload != std::vector<uint8_t>{'1'})
      throw std::runtime_error("Invalid renderer startup handshake");
  } catch (...) { Stop(); throw; }
}
RendererProcess::~RendererProcess() { Stop(); }
void RendererProcess::Stop() noexcept {
  if (fd_ >= 0) { close(fd_); fd_ = -1; }
  if (pid_ > 0) {
    // No detached zombies or unbounded graceful-shutdown wait. Only our own child.
    int status = 0;
    pid_t result;
    do { result = waitpid(pid_, &status, WNOHANG); } while (result < 0 && errno == EINTR);
    if (result == 0) {
      kill(pid_, SIGKILL);
      do { result = waitpid(pid_, &status, 0); } while (result < 0 && errno == EINTR);
    }
    pid_ = -1;
  }
}
std::vector<uint8_t> RendererProcess::Command(const std::string& json) {
  if (std::this_thread::get_id() != owner_) throw std::runtime_error("Wrong renderer proxy owner thread");
  if (fd_ < 0) throw std::runtime_error("Renderer is closed");
  if (json.empty() || json.size() > wire::kMaxRequest) throw std::invalid_argument("Invalid renderer request size");
  if (++sequence_ == 0) { Stop(); throw std::runtime_error("Renderer sequence exhausted"); }
  const auto deadline = std::chrono::steady_clock::now() + timeout_;
  wire::Frame response;
  try {
    wire::Send(fd_, {sequence_, wire::kRequest, {json.begin(), json.end()}}, deadline);
    response = wire::Receive(fd_, wire::kMaxResponse, deadline);
    if (response.sequence != sequence_ || (response.kind != wire::kSuccess && response.kind != wire::kError))
      throw std::runtime_error("Uncorrelated renderer response");
  } catch (...) { Stop(); throw; }
  // Application errors do not corrupt the connection.
  if (response.kind == wire::kError) throw std::runtime_error(std::string(response.payload.begin(), response.payload.end()));
  return std::move(response.payload);
}
}

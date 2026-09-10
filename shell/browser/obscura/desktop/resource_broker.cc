// Copyright Weber contributors. SPDX-License-Identifier: MIT
#include "resource_broker.h"
#include "../../../common/obscura/wire.h"
#include <glib.h>
#include <fstream>
#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>
namespace weber::desktop {
namespace wire = electron::obscura::wire;
using namespace std::chrono_literals;
ResourceBroker::ResourceBroker(std::function<void(const Json&)> emit) : emit_(std::move(emit)) {
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) throw std::runtime_error("Resource socketpair failed");
  parent_ = pair[0]; child_ = pair[1];
  try { reader_ = std::thread([this] { Run(); }); }
  catch (...) { close(parent_); close(child_); throw; }
}
void ResourceBroker::ChildSpawned() { if (child_ >= 0) { close(child_); child_ = -1; } }
void ResourceBroker::Cancel() {
  stopped_ = true; shutdown(parent_, SHUT_RDWR); wake_.notify_all();
}
ResourceBroker::~ResourceBroker() {
  Cancel(); if (reader_.joinable()) reader_.join();
  close(parent_); ChildSpawned();
}
void ResourceBroker::Resolve(uint32_t id, Json response) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (stopped_ || !id || id != pending_ || resolved_) throw std::runtime_error("Resource request expired or already resolved");
  response_ = std::move(response); resolved_ = true; wake_.notify_one();
}
void ResourceBroker::Run() {
  uint32_t previous = 0;
  try {
    while (!stopped_) {
      auto frame = wire::Receive(parent_, wire::kMaxRequest, wire::Deadline::max());
      if (frame.kind != wire::kRequest || !frame.sequence || frame.sequence != previous + 1)
        throw std::runtime_error("Invalid resource request sequence");
      previous = frame.sequence;
      const auto deadline = std::chrono::steady_clock::now() + 30s;
      Json request = Json::parse(frame.payload.begin(), frame.payload.end());
      { std::lock_guard<std::mutex> lock(mutex_); pending_ = previous; resolved_ = false; response_ = nullptr; }
      emit_({{"resourceId", previous}, {"request", std::move(request)}});
      Json response;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        if (!wake_.wait_until(lock, deadline, [&] { return stopped_ || resolved_; }) || stopped_)
          throw std::runtime_error("Resource handler timed out or window closed");
        response = std::move(response_); pending_ = 0;
      }
      std::vector<uint8_t> body;
      try {
        if (response.contains("error")) throw std::runtime_error(response["error"].dump());
        if (response.contains("path")) {
          const auto path = response.at("path").get<std::string>();
          if (path.empty() || path[0] != '/' || path.find('\0') != std::string::npos)
            throw std::runtime_error("Protocol file must have an absolute path");
          // This path is authorized by the application's main-process handler,
          // never supplied directly by the renderer request.
          std::ifstream file(path, std::ios::binary | std::ios::ate);
          if (!file) throw std::runtime_error("Protocol file could not be opened");
          const auto size = file.tellg();
          if (size < 0 || size > wire::kMaxResponse) throw std::runtime_error("Protocol file exceeds 64 MiB");
          body.resize(static_cast<size_t>(size)); file.seekg(0);
          if (!body.empty() && !file.read(reinterpret_cast<char*>(body.data()), body.size()))
            throw std::runtime_error("Protocol file read failed");
          response.erase("path");
        } else if (response.contains("data")) {
          gsize length = 0;
          auto* bytes = g_base64_decode(response.at("data").get<std::string>().c_str(), &length);
          body.assign(bytes, bytes + length); g_free(bytes); response.erase("data");
        }
        response["bodyLength"] = body.size();
        const auto header = response.dump();
        wire::Send(parent_, {previous, wire::kSuccess, {header.begin(), header.end()}}, deadline);
        wire::Send(parent_, {previous, wire::kSuccess, std::move(body)}, deadline);
      } catch (const std::exception& error) {
        const std::string message = error.what();
        wire::Send(parent_, {previous, wire::kError, {message.begin(), message.end()}}, deadline);
      }
    }
  } catch (...) { Cancel(); }
}
}

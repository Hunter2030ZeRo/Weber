// Copyright Weber contributors. SPDX-License-Identifier: Apache-2.0
#include "obscura_engine.h"
#include "engine_abi.h"
#include <exception>
#include <stdexcept>
namespace electron::obscura {
namespace {
struct Reply { std::vector<uint8_t> bytes; std::exception_ptr error; };
void Collect(const uint8_t* data, size_t len, void* user) noexcept {
  auto* reply = static_cast<Reply*>(user);
  try { reply->bytes.assign(data, data + len); }
  catch (...) { reply->error = std::current_exception(); }
}
}
ObscuraEngine::ObscuraEngine() : handle_(0), owner_(std::this_thread::get_id()) {
  if (weber_engine_abi_version() != 1) throw std::runtime_error("Unsupported Obscura ABI");
  handle_ = weber_engine_create();
  if (!handle_) throw std::runtime_error("Obscura initialization failed or owner already has an engine");
}
ObscuraEngine::~ObscuraEngine() {
  // Destroying on another thread would leave V8's owner-thread state alive.
  if (owner_ != std::this_thread::get_id() || weber_engine_destroy(handle_) != 0)
    std::terminate();
}
std::vector<uint8_t> ObscuraEngine::Command(const std::string& json) {
  if (owner_ != std::this_thread::get_id()) throw std::runtime_error("Wrong Obscura owner thread");
  Reply reply;
  const int status = weber_engine_command(handle_, reinterpret_cast<const uint8_t*>(json.data()),
                                          json.size(), Collect, &reply);
  if (reply.error) std::rethrow_exception(reply.error);
  if (status) throw std::runtime_error(std::string(reply.bytes.begin(), reply.bytes.end()));
  return reply.bytes;
}
}

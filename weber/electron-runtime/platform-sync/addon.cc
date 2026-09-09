// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
// Stable Node-API only: this library also loads in Bun without a V8 dependency.
#define NAPI_VERSION 8
#include <node_api.h>
#include "../../../shell/browser/obscura/desktop/platform_wire.h"
#include <memory>
#include <vector>

namespace {
using namespace weber::platform_wire;
constexpr napi_type_tag kChannelTag{0xa317f48c0e6d49b2ull, 0xb486d205725ac138ull};
struct Channel {
  int parent = -1;
  int child = -1;
  ~Channel() { Close(); }
  void Close() {
    if (parent >= 0) { shutdown(parent, SHUT_RDWR); close(parent); parent = -1; }
    if (child >= 0) { close(child); child = -1; }
  }
};
void Check(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("Invalid platform transport argument");
}
Channel* Get(napi_env env, napi_value value) {
  bool matches = false;
  Check(napi_check_object_type_tag(env, value, &kChannelTag, &matches));
  if (!matches) throw std::runtime_error("Invalid platform transport handle type");
  void* data = nullptr;
  Check(napi_unwrap(env, value, &data));
  if (!data) throw std::runtime_error("Invalid platform transport handle");
  return static_cast<Channel*>(data);
}
napi_value Throw(napi_env env, const std::exception& error) {
  napi_throw_error(env, "ERR_WEBER_PLATFORM_SYNC", error.what());
  return nullptr;
}
napi_value Create(napi_env env, napi_callback_info) {
  try {
    auto channel = std::make_unique<Channel>();
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0)
      throw std::runtime_error("Cannot create private platform socketpair");
    channel->parent = pair[0]; channel->child = pair[1];
    Nonblocking(channel->parent);
    napi_value result;
    Check(napi_create_object(env, &result));
    Check(napi_type_tag_object(env, result, &kChannelTag));
    Check(napi_wrap(env, result, channel.get(), [](napi_env, void* value, void*) {
      delete static_cast<Channel*>(value);
    }, nullptr, nullptr));
    channel.release();
    return result;
  } catch (const std::exception& error) { return Throw(env, error); }
}
napi_value ChildFd(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value argv[1];
    Check(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    if (argc != 1) throw std::runtime_error("Expected platform channel");
    const auto* channel = Get(env, argv[0]);
    if (channel->child < 0) throw std::runtime_error("Platform child descriptor is already released");
    napi_value result; Check(napi_create_int32(env, channel->child, &result)); return result;
  } catch (const std::exception& error) { return Throw(env, error); }
}
napi_value ReleaseChild(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value argv[1];
    Check(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    if (argc != 1) throw std::runtime_error("Expected platform channel");
    auto* channel = Get(env, argv[0]);
    if (channel->child >= 0) { close(channel->child); channel->child = -1; }
    napi_value result; Check(napi_get_undefined(env, &result)); return result;
  } catch (const std::exception& error) { return Throw(env, error); }
}
napi_value Request(napi_env env, napi_callback_info info) {
  Channel* channel = nullptr;
  try {
    size_t argc = 3; napi_value argv[3];
    Check(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    if (argc != 3) throw std::runtime_error("Expected channel, JSON request and timeout");
    channel = Get(env, argv[0]);
    if (channel->parent < 0) throw std::runtime_error("Platform channel is closed");
    size_t size = 0;
    Check(napi_get_value_string_utf8(env, argv[1], nullptr, 0, &size));
    if (!size || size > kLimit) throw std::runtime_error("Platform request exceeds 64 KiB");
    std::vector<char> bytes(size + 1);
    Check(napi_get_value_string_utf8(env, argv[1], bytes.data(), bytes.size(), &size));
    uint32_t timeout;
    Check(napi_get_value_uint32(env, argv[2], &timeout));
    if (timeout < 1 || timeout > 5000) throw std::runtime_error("Platform timeout must be 1–5000 ms");
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeout);
    Write(channel->parent, std::string(bytes.data(), size), deadline);
    const auto response = Read(channel->parent, deadline);
    napi_value result;
    Check(napi_create_string_utf8(env, response.data(), response.size(), &result));
    return result;
  } catch (const std::exception& error) {
    // An incomplete transaction poisons the channel. A later request must never
    // consume a late response and mistake it for its own result.
    if (channel) channel->Close();
    return Throw(env, error);
  }
}
napi_value Close(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value argv[1];
    Check(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    if (argc != 1) throw std::runtime_error("Expected platform channel");
    Get(env, argv[0])->Close();
    napi_value result; Check(napi_get_undefined(env, &result)); return result;
  } catch (const std::exception& error) { return Throw(env, error); }
}
napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"childFd", nullptr, ChildFd, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseChild", nullptr, ReleaseChild, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"request", nullptr, Request, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 5, methods) != napi_ok) return nullptr;
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

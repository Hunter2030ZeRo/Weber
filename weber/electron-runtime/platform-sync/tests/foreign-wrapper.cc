// Test-only native object owned by another addon. It is never a platform channel.
#define NAPI_VERSION 8
#include <node_api.h>
#include <climits>
#include <memory>
#include <stdexcept>

namespace {
// These sentinel integers are deliberately not live operating-system handles.
struct Foreign {
  int first = INT_MAX;
  int second = INT_MAX - 1;
};
const napi_type_tag kForeignTag{0x7fe8a5d9f50bb2c1ULL, 0xa163edbf49e72c30ULL};
void Check(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("Foreign-wrapper fixture Node-API call failed");
}
napi_value Fail(napi_env env, const std::exception& error) {
  napi_throw_error(env, "ERR_TEST_FOREIGN_WRAPPER", error.what());
  return nullptr;
}
napi_value Create(napi_env env, napi_callback_info) {
  try {
    auto foreign = std::make_unique<Foreign>();
    napi_value result;
    Check(napi_create_object(env, &result));
    Check(napi_type_tag_object(env, result, &kForeignTag));
    Check(napi_wrap(env, result, foreign.get(), [](napi_env, void* data, void*) {
      delete static_cast<Foreign*>(data);
    }, nullptr, nullptr));
    foreign.release();
    return result;
  } catch (const std::exception& error) { return Fail(env, error); }
}
napi_value Inspect(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1;
    napi_value argv[1];
    Check(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    if (argc != 1) throw std::runtime_error("Expected foreign wrapper");
    bool valid = false;
    Check(napi_check_object_type_tag(env, argv[0], &kForeignTag, &valid));
    if (!valid) throw std::runtime_error("Not a foreign wrapper");
    void* data = nullptr;
    Check(napi_unwrap(env, argv[0], &data));
    if (!data) throw std::runtime_error("Foreign wrapper is empty");
    const auto* foreign = static_cast<Foreign*>(data);
    napi_value result, first, second;
    Check(napi_create_array_with_length(env, 2, &result));
    Check(napi_create_int32(env, foreign->first, &first));
    Check(napi_create_int32(env, foreign->second, &second));
    Check(napi_set_element(env, result, 0, first));
    Check(napi_set_element(env, result, 1, second));
    return result;
  } catch (const std::exception& error) { return Fail(env, error); }
}
napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspect", nullptr, Inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 2, methods) != napi_ok) return nullptr;
  return exports;
}
}  // namespace
NAPI_MODULE(foreign_wrapper_fixture, Init)

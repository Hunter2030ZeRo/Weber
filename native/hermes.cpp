#include "native/hermes.hpp"
#include "weber-servo/src/aot.rs.h"
#include <hermes/VM/static_h.h>
#include <jsi/instrumentation.h>
#include <cmath>
#include <chrono>
#include <limits>
#include <stdexcept>
#include <atomic>
#include <dlfcn.h>
#include "wpt-units.hpp"

extern "C" SHUnit *sh_export_weber_logic();
extern "C" SHUnit *sh_export_weber_platform();

namespace weber {
namespace {
class WireBuffer final : public facebook::jsi::MutableBuffer {
 public:
  explicit WireBuffer(const std::uint8_t* data, std::size_t size) : bytes_(data, data + size) {}
  std::size_t size() const override { return bytes_.size(); }
  std::uint8_t* data() override { return bytes_.data(); }
 private: std::vector<std::uint8_t> bytes_;
};
facebook::jsi::Object decode_wire(facebook::jsi::Runtime& runtime, rust::Slice<const std::uint8_t> bytes) {
  auto buffer = facebook::jsi::ArrayBuffer(runtime, std::make_shared<WireBuffer>(bytes.data(), bytes.size()));
  auto array = runtime.global().getPropertyAsFunction(runtime, "Uint8Array").callAsConstructor(runtime, buffer);
  return runtime.global().getPropertyAsObject(runtime, "WeberWire").getPropertyAsFunction(runtime, "decode").call(runtime, array).asObject(runtime);
}
}

Runtime::Runtime() : runtime_(facebook::hermes::makeHermesRuntime(hermes::vm::RuntimeConfig::Builder().withES6BlockScoping(true).build())) {
  auto queue = facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "queueMicrotask"), 1,
      [](facebook::jsi::Runtime& runtime, const facebook::jsi::Value&, const facebook::jsi::Value* args, std::size_t count) -> facebook::jsi::Value {
        if (count != 1 || !args[0].isObject() || !args[0].asObject(runtime).isFunction(runtime)) throw facebook::jsi::JSError(runtime, "Expected microtask callback");
        runtime.queueMicrotask(args[0].asObject(runtime).asFunction(runtime));
        return facebook::jsi::Value::undefined();
      });
  runtime_->global().setProperty(*runtime_, "queueMicrotask", queue);
  const auto origin = std::chrono::steady_clock::now();
  auto clock = facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "weberMonotonicNow"), 0,
      [origin](facebook::jsi::Runtime&, const facebook::jsi::Value&, const facebook::jsi::Value*, std::size_t) -> facebook::jsi::Value {
        return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - origin).count();
      });
  runtime_->global().setProperty(*runtime_, "weberMonotonicNow", clock);
  auto heap = facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "weberHeapInfo"), 0,
      [](facebook::jsi::Runtime& runtime, const facebook::jsi::Value&, const facebook::jsi::Value*, std::size_t) -> facebook::jsi::Value {
        facebook::jsi::Object result(runtime);
        for (const auto& entry : runtime.instrumentation().getHeapInfo(false)) result.setProperty(runtime, entry.first.c_str(), static_cast<double>(entry.second));
        return result;
      });
  runtime_->global().setProperty(*runtime_, "weberHeapInfo", heap);
  auto session = facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "weberNextSession"), 0,
      [](facebook::jsi::Runtime&, const facebook::jsi::Value&, const facebook::jsi::Value*, std::size_t) -> facebook::jsi::Value {
        static std::atomic<std::uint64_t> next{1};
        const auto value = next.fetch_add(1);
        if (value > std::numeric_limits<std::uint32_t>::max()) throw std::runtime_error("DOM session space exhausted");
        return static_cast<double>(value);
      });
  runtime_->global().setProperty(*runtime_, "weberNextSession", session);
  auto query = facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "weberDomQuery"), 1,
      [](facebook::jsi::Runtime& runtime, const facebook::jsi::Value&, const facebook::jsi::Value* args, std::size_t count) -> facebook::jsi::Value {
        if (count != 1 || !args[0].isString()) throw facebook::jsi::JSError(runtime, "DOM query requires a string");
        try {
          auto result = dom_query(args[0].asString(runtime).utf8(runtime));
          return facebook::jsi::String::createFromUtf8(runtime, std::string(result));
        } catch (const std::exception& error) { throw facebook::jsi::JSError(runtime, error.what()); }
      });
  runtime_->global().setProperty(*runtime_, "weberDomQuery", query);
  runtime_->global().setProperty(*runtime_, "weberBackendTransport", facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "weberBackendTransport"), 1,
      [](facebook::jsi::Runtime& runtime, const facebook::jsi::Value&, const facebook::jsi::Value* args, std::size_t count) -> facebook::jsi::Value {
        if (count != 1 || !args[0].isString()) throw facebook::jsi::JSError(runtime, "Backend request requires JSON text");
        auto result = backend_exchange(args[0].asString(runtime).utf8(runtime));
        return facebook::jsi::String::createFromUtf8(runtime, std::string(result));
      }));
  runtime_->global().setProperty(*runtime_, "weberNativeTransport", facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "weberNativeTransport"), 1,
      [](facebook::jsi::Runtime& runtime, const facebook::jsi::Value&, const facebook::jsi::Value* args, std::size_t count) -> facebook::jsi::Value {
        if (count != 1 || !args[0].isString()) throw facebook::jsi::JSError(runtime, "Native request requires JSON text");
        auto result = native_exchange(args[0].asString(runtime).utf8(runtime));
        return facebook::jsi::String::createFromUtf8(runtime, std::string(result));
      }));
  runtime_->global().setProperty(*runtime_, "weberDomQueryBytes", facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "weberDomQueryBytes"), 1,
      [](facebook::jsi::Runtime& runtime, const facebook::jsi::Value&, const facebook::jsi::Value* args, std::size_t count) -> facebook::jsi::Value {
        if (count != 1 || !args[0].isObject() || !args[0].asObject(runtime).isArrayBuffer(runtime)) throw facebook::jsi::JSError(runtime, "DOM query requires an ArrayBuffer");
        auto buffer = args[0].asObject(runtime).getArrayBuffer(runtime);
        try {
          auto result = dom_query_bytes(rust::Slice<const std::uint8_t>(buffer.data(runtime), buffer.size(runtime)));
          return facebook::jsi::ArrayBuffer(runtime, std::make_shared<WireBuffer>(result.data(), result.size()));
        } catch (const std::exception& error) { throw facebook::jsi::JSError(runtime, error.what()); }
      }));

  runtime_->global().setProperty(*runtime_, "weberCanQuery", facebook::jsi::Function::createFromHostFunction(*runtime_, facebook::jsi::PropNameID::forAscii(*runtime_, "weberCanQuery"), 0,
      [](facebook::jsi::Runtime&, const facebook::jsi::Value&, const facebook::jsi::Value*, std::size_t) -> facebook::jsi::Value { return dom_query_available(); }));
  if (!_sh_initialize_units(runtime_->getSHRuntime(), 2, sh_export_weber_platform, sh_export_weber_logic))
    throw std::runtime_error("Static Hermes unit initialization failed");
}
std::int32_t Runtime::increment(std::int32_t delta) {
  auto function = runtime_->global().getPropertyAsFunction(*runtime_, "weberIncrement");
  double result = function.call(*runtime_, delta).asNumber();
  if (!std::isfinite(result) || std::floor(result) != result ||
      result < std::numeric_limits<std::int32_t>::min() ||
      result > std::numeric_limits<std::int32_t>::max())
    throw std::runtime_error("AOT result outside int32 range");
  return static_cast<std::int32_t>(result);
}
std::unique_ptr<Runtime> create_runtime() { return std::make_unique<Runtime>(); }
Runtime::~Runtime() {
  // Native functions and unit metadata point into these modules until all JS
  // objects and the runtime have been destroyed.
  runtime_.reset();
  for (auto library : application_libraries_) dlclose(library);
}
void Runtime::load_application(rust::Str path, rust::Slice<const std::uint8_t> request, bool binary) {
  if (!application_libraries_.empty()) throw std::runtime_error("An application is already loaded");
  auto library = dlopen(std::string(path).c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!library) throw std::runtime_error(std::string("Native application load failed: ") + dlerror());
  auto unit = reinterpret_cast<SHUnit *(*)()>(dlsym(library, "sh_export_weber_application"));
  if (!unit) { dlclose(library); throw std::runtime_error("Native application entry is missing"); }
  application_libraries_.push_back(library);
  auto json = runtime_->global().getPropertyAsObject(*runtime_, "JSON");
  // Parse the original wire bytes in the same JS engine that will consume later
  // requests. A Rust f64 parse/format round trip can shift timeOrigin by one ULP.
  auto envelope = binary ? decode_wire(*runtime_, request) : json.getPropertyAsFunction(*runtime_, "parse").call(*runtime_, facebook::jsi::String::createFromUtf8(*runtime_, request.data(), request.size())).asObject(*runtime_);
  auto documentClock = envelope.getProperty(*runtime_, "clock");
  runtime_->global().getPropertyAsFunction(*runtime_, "weberPrepareApplication").call(*runtime_, documentClock);
  if (!_sh_initialize_units(runtime_->getSHRuntime(), 1, unit)) throw std::runtime_error("Native application initialization failed");
}
rust::String Runtime::dom_start() {
  auto function = runtime_->global().getPropertyAsFunction(*runtime_, "weberDomStart");
  function.call(*runtime_); return flush_dom();
}
rust::String Runtime::dom_browser() {
  auto function = runtime_->global().getPropertyAsFunction(*runtime_, "weberBrowserStart");
  function.call(*runtime_); return flush_dom();
}
rust::String Runtime::dom_event(rust::Str event) {
  auto function = runtime_->global().getPropertyAsFunction(*runtime_, "weberDomEvent");
  auto input = facebook::jsi::String::createFromUtf8(*runtime_, std::string(event));
  function.call(*runtime_, input); return flush_dom();
}
rust::String Runtime::dom_dispose() {
  auto function = runtime_->global().getPropertyAsFunction(*runtime_, "weberDomDispose");
  function.call(*runtime_); return flush_dom();
}
rust::String Runtime::flush_dom(bool checkpoint) {
  if (checkpoint) runtime_->drainMicrotasks();
  return runtime_->global().getPropertyAsFunction(*runtime_, "weberDomFlush").call(*runtime_).asString(*runtime_).utf8(*runtime_);
}
rust::String Runtime::browser_contracts() {
  auto result = runtime_->global().getPropertyAsFunction(*runtime_, "weberBrowserContracts").call(*runtime_);
  runtime_->drainMicrotasks();
  if (!runtime_->global().getProperty(*runtime_, "weberObserverCheckpointPassed").getBool()) throw std::runtime_error("Observer microtask delivery failed");
  return result.asString(*runtime_).utf8(*runtime_);
}
rust::String Runtime::host_call(rust::Str request, bool checkpoint, bool collect, bool report) {
  if (collect) { runtime_->drainMicrotasks(); runtime_->instrumentation().collectGarbage("Weber DOM ownership checkpoint"); }
  auto input = facebook::jsi::String::createFromUtf8(*runtime_, std::string(request));
  auto decision = runtime_->global().getPropertyAsFunction(*runtime_, "weberHostCall").call(*runtime_, input).asString(*runtime_).utf8(*runtime_);
  auto commands = std::string(flush_dom(checkpoint));
  auto data = report ? std::string(wpt_status()) : "null";
  return "{\"decision\":" + decision + ",\"commands\":" + commands + ",\"data\":" + data + "}";
}
rust::Vec<std::uint8_t> Runtime::host_call_bytes(rust::Slice<const std::uint8_t> request, bool checkpoint, bool collect, bool report) {
  if (collect) { runtime_->drainMicrotasks(); runtime_->instrumentation().collectGarbage("Weber DOM ownership checkpoint"); }
  auto input = decode_wire(*runtime_, request);
  auto decision = runtime_->global().getPropertyAsFunction(*runtime_, "weberHostCall").call(*runtime_, input);
  if (checkpoint) runtime_->drainMicrotasks();
  auto data = report ? runtime_->global().getPropertyAsFunction(*runtime_, "weberWptData").call(*runtime_) : facebook::jsi::Value::null();
  auto buffer = runtime_->global().getPropertyAsFunction(*runtime_, "weberHostReplyBytes").call(*runtime_, decision, data).asObject(*runtime_).getArrayBuffer(*runtime_);
  const auto size = buffer.size(*runtime_);
  if (size > 1048576) throw std::runtime_error("Host reply exceeds wire limit");
  return copy_wire_bytes(rust::Slice<const std::uint8_t>(buffer.data(*runtime_), size));
}
rust::String Runtime::lifetime_contracts() {
  runtime_->global().getPropertyAsFunction(*runtime_, "weberLifetimePrepare").call(*runtime_);
  runtime_->drainMicrotasks(); runtime_->instrumentation().collectGarbage("Weber detached DOM lifetime test");
  runtime_->drainMicrotasks();
  return runtime_->global().getPropertyAsFunction(*runtime_, "weberLifetimeVerify").call(*runtime_).asString(*runtime_).utf8(*runtime_);
}
rust::String Runtime::solid_contracts() {
  auto result = runtime_->global().getPropertyAsFunction(*runtime_, "weberSolidContracts").call(*runtime_);
  runtime_->drainMicrotasks();
  return result.asString(*runtime_).utf8(*runtime_);
}
rust::String Runtime::scheduler_contracts() {
  auto result = runtime_->global().getPropertyAsFunction(*runtime_, "weberSchedulerContracts").call(*runtime_);
  runtime_->drainMicrotasks();
  if (runtime_->global().getProperty(*runtime_, "weberSchedulerMicrotasks").asNumber() != 2) throw std::runtime_error("Scheduler microtask checkpoint failed");
  return result.asString(*runtime_).utf8(*runtime_);
}
rust::String Runtime::wpt_start(std::uint32_t index) {
  if (!runtime_->global().getProperty(*runtime_, "weberWptReport").isUndefined()) throw std::runtime_error("Each WPT file requires a fresh runtime");
  if (!initialize_wpt(runtime_->getSHRuntime(), index)) throw std::runtime_error("WPT native initialization failed");
  runtime_->global().getPropertyAsFunction(*runtime_, "weberWptFinish").call(*runtime_);
  runtime_->drainMicrotasks();
  return wpt_status();
}
rust::String Runtime::wpt_status() {
  return runtime_->global().getPropertyAsFunction(*runtime_, "weberWptStatus").call(*runtime_).asString(*runtime_).utf8(*runtime_);
}
}

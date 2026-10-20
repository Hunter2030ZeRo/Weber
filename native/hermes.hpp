#pragma once
#include <cstdint>
#include <memory>
#include <vector>
#include <hermes/hermes.h>
#include "rust/cxx.h"

namespace weber {
class Runtime {
 public:
  Runtime();
  ~Runtime();
  void load_application(rust::Str path, rust::Slice<const std::uint8_t> request, bool binary);
  std::int32_t increment(std::int32_t delta);
  rust::String dom_start();
  rust::String dom_browser();
  rust::String browser_contracts();
  rust::String solid_contracts();
  rust::String scheduler_contracts();
  rust::String wpt_start(std::uint32_t index);
  rust::String wpt_status();
  rust::String host_call(rust::Str request, bool checkpoint, bool collect, bool report);
  rust::Vec<std::uint8_t> host_call_bytes(rust::Slice<const std::uint8_t> request, bool checkpoint, bool collect, bool report);
  rust::String lifetime_contracts();
  rust::String dom_event(rust::Str event);
  rust::String dom_dispose();
 private:
  rust::String flush_dom(bool checkpoint = true);
  std::unique_ptr<facebook::hermes::HermesRuntime> runtime_;
  std::vector<void*> application_libraries_;
};
std::unique_ptr<Runtime> create_runtime();
}

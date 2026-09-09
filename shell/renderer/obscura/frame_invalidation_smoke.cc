// SPDX-License-Identifier: Apache-2.0
#include "obscura_engine.h"
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

using electron::obscura::ObscuraEngine;
using namespace std::chrono_literals;
namespace {
void Check(bool value, const char* error) {
  if (!value) throw std::runtime_error(error);
}
uint32_t ReadLE(const uint8_t* bytes) {
  return uint32_t(bytes[0]) | uint32_t(bytes[1]) << 8 |
      uint32_t(bytes[2]) << 16 | uint32_t(bytes[3]) << 24;
}
void Frame(const std::vector<uint8_t>& bytes, uint32_t width, uint32_t height) {
  Check(bytes.size() == 12 + size_t(width) * height * 4, "Wrong raw frame size");
  Check(std::string(bytes.begin(), bytes.begin() + 4) == "OBF1", "Wrong frame magic");
  Check(ReadLE(bytes.data() + 4) == width && ReadLE(bytes.data() + 8) == height,
        "Wrong frame dimensions");
}
std::vector<uint8_t> Changed(ObscuraEngine& engine) {
  return engine.Command(R"({"method":"captureFrameIfChanged"})");
}
void Unchanged(ObscuraEngine& engine) {
  Check(Changed(engine).empty(), "Unchanged document produced another frame");
}
std::vector<uint8_t> AwaitDamage(ObscuraEngine& engine) {
  const auto deadline = std::chrono::steady_clock::now() + 3s;
  while (std::chrono::steady_clock::now() < deadline) {
    engine.Command(R"({"method":"tick"})");
    auto bytes = Changed(engine);
    if (!bytes.empty()) return bytes;
    std::this_thread::sleep_for(5ms);
  }
  throw std::runtime_error("Timer damage did not produce a frame");
}
}
int main() {
  try {
    std::ofstream("frame-invalidation.html") <<
        "<!doctype html><html style='margin:0'><body style='margin:0;background:red'>"
        "<div id='box' style='width:20px;height:20px;background:blue'></div></body></html>";
    ObscuraEngine engine;
    engine.Command(R"({"method":"viewport","width":64,"height":64})");
    engine.Command(R"({"method":"loadFile","path":"frame-invalidation.html"})");
    auto first = Changed(engine);
    Frame(first, 64, 64);
    for (unsigned i = 0; i < 100; ++i) Unchanged(engine);
    engine.Command(R"({"method":"evaluate","source":"document.body.textContent"})");
    Unchanged(engine);

    engine.Command(R"({"method":"evaluate","source":"document.body.style.backgroundColor='green'; null"})");
    auto dom = Changed(engine);
    Frame(dom, 64, 64);
    Check(dom != first, "DOM mutation was acknowledged without new pixels");
    Unchanged(engine);

    engine.Command(R"({"method":"evaluate","source":"setTimeout(()=>{document.body.style.backgroundColor='yellow'},80); null"})");
    Unchanged(engine);
    auto timer = AwaitDamage(engine);
    Frame(timer, 64, 64);
    Check(timer != dom, "Timer mutation was acknowledged without new pixels");
    Unchanged(engine);

    engine.Command(R"({"method":"viewport","width":80,"height":50})");
    Frame(Changed(engine), 80, 50);
    Unchanged(engine);
    engine.Command(R"({"method":"viewport","width":80,"height":50})");
    Unchanged(engine);

    engine.Command(R"({"method":"evaluate","source":"globalThis.canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;canvas.style.cssText='position:absolute;left:0;top:0';document.body.appendChild(canvas);globalThis.ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,20,20);null"})");
    auto canvas = Changed(engine);
    Frame(canvas, 80, 50);
    Unchanged(engine);
    engine.Command(R"({"method":"evaluate","source":"ctx.fillStyle='blue';ctx.fillRect(0,0,20,20);null"})");
    auto canvas_update = Changed(engine);
    Frame(canvas_update, 80, 50);
    Check(canvas_update != canvas, "Canvas paint did not invalidate frame pixels");
    Unchanged(engine);

    engine.Command(R"({"method":"evaluate","source":"setTimeout(()=>{ctx.fillStyle='green';ctx.fillRect(0,0,20,20)},80);null"})");
    auto canvas_timer = AwaitDamage(engine);
    Frame(canvas_timer, 80, 50);
    Check(canvas_timer != canvas_update, "Timed canvas paint did not change pixels");
    Unchanged(engine);

    // Same URL and same initial generation must still repaint a new document.
    engine.Command(R"({"method":"loadFile","path":"frame-invalidation.html"})");
    Frame(Changed(engine), 80, 50);
    Unchanged(engine);

    engine.Command(R"({"method":"evaluate","source":"let style=document.createElement('style');style.textContent='@keyframes move { from { transform:translateX(0px) } to { transform:translateX(30px) } } #box { animation:move 0.3s linear forwards }';document.head.appendChild(style);null"})");
    auto animation_start = Changed(engine);
    Frame(animation_start, 80, 50);
    std::this_thread::sleep_for(40ms);
    auto animation_next = Changed(engine);
    Frame(animation_next, 80, 50);
    Check(animation_next != animation_start, "Active CSS animation did not repaint");
    std::this_thread::sleep_for(400ms);
    Frame(Changed(engine), 80, 50); // Paint final animation sample once.
    Unchanged(engine);
    std::cout << "Damage-aware Obscura frames: idle skip, DOM, timer, resize, canvas, navigation, CSS animation passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}

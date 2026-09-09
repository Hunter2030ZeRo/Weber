// Copyright Weber contributors. SPDX-License-Identifier: Apache-2.0
#include "obscura_engine.h"
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>
using electron::obscura::ObscuraEngine;
void Check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
void Fails(ObscuraEngine& engine, const std::string& request) {
  bool rejected = false;
  try { engine.Command(request); } catch (const std::runtime_error&) { rejected = true; }
  Check(rejected, "Expected an explicit engine error");
}
int main() {
  try {
    std::ofstream("engine-smoke.html") << "<!doctype html><html><body style='background:red'><h1>Obscura from Electron C++</h1></body></html>";
    ObscuraEngine engine;
    Fails(engine, R"json({"method":"capturePng"})json");
    Fails(engine, R"json({"method":"viewport","width":99999,"height":600})json");
    Fails(engine, "{broken");
    Fails(engine, R"json({"method":"unknown"})json");
    Fails(engine, R"json({"method":"loadFile","path":"does-not-exist.html"})json");
    engine.Command(R"json({"method":"loadFile","path":"engine-smoke.html"})json");
    const auto title = engine.Command(R"json({"method":"evaluate","source":"document.querySelector('h1').textContent"})json");
    Check(std::string(title.begin(), title.end()) == "\"Obscura from Electron C++\"", "DOM mismatch");
    Fails(engine, R"json({"method":"evaluate","source":"throw new Error('observable')"})json");
    const auto first = engine.Command(R"json({"method":"capturePng"})json");
    Check(first.size() > 100 && first[0] == 137 && first[1] == 'P' && first[2] == 'N' && first[3] == 'G', "Expected PNG rendering");
    engine.Command(R"json({"method":"evaluate","source":"document.body.style.backgroundColor = 'blue'; null"})json");
    const auto second = engine.Command(R"json({"method":"capturePng"})json");
    Check(first != second, "DOM mutation did not change rendered pixels");
    bool denied = false;
    std::thread other([&] { try { engine.Command("{}"); } catch (const std::runtime_error&) { denied = true; } });
    other.join();
    Check(denied, "Cross-thread access accepted");
    std::ofstream image("engine-smoke.png", std::ios::binary);
    image.write(reinterpret_cast<const char*>(second.data()), second.size());
    std::cout << "Electron-tree C++ -> Obscura DOM/evaluation/rendering smoke passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}

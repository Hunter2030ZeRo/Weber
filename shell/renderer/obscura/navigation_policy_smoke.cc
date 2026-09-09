// SPDX-License-Identifier: Apache-2.0
#include "obscura_engine.h"
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using electron::obscura::ObscuraEngine;
namespace {
void Check(bool value, const char* error) {
  if (!value) throw std::runtime_error(error);
}
std::string Text(const std::vector<uint8_t>& bytes) {
  return std::string(bytes.begin(), bytes.end());
}
}
int main() {
  try {
    const std::string target = "data:text/html,%3Cscript%3EglobalThis.forbiddenDocument%3Dtrue%3C%2Fscript%3E";
    std::ofstream("navigation-policy.html") <<
        "<!doctype html><html><body><script>globalThis.sourceDocument=true;location.href='" <<
        target << "';</script><h1>Authorized starting document</h1></body></html>";
    ObscuraEngine engine;
    engine.Command(R"({"method":"configurePreload","source":"const {contextBridge}=require('electron');globalThis.privateToken='preload';contextBridge.exposeInMainWorld('desktopApi',{token:()=>globalThis.privateToken});"})");
    const auto loaded = Text(engine.Command(R"({"method":"loadFile","path":"navigation-policy.html"})"));
    Check(loaded.find("navigation-policy.html") != std::string::npos,
          "Author navigation replaced the approved document during load");
    Check(Text(engine.Command(R"({"method":"evaluate","source":"[typeof sourceDocument,typeof forbiddenDocument,typeof desktopApi]"})")) ==
          "[\"boolean\",\"undefined\",\"object\"]",
          "Unexpected destination author code or preload executed");
    const auto events = Text(engine.Command(R"({"method":"pollEvents"})"));
    Check(events.find("navigation-requested") != std::string::npos &&
          events.find(target) != std::string::npos &&
          events.find("sourceURL") != std::string::npos,
          "Browser owner did not receive the pending destination and source");
    const auto after = Text(engine.Command(R"({"method":"getState"})"));
    Check(after.find("navigation-policy.html") != std::string::npos,
          "Polling implicitly authorized pending navigation");

    // Only an explicit host command authorizes entering the other origin.
    engine.Command("{\"method\":\"loadURL\",\"url\":\"" + target + "\"}");
    Check(Text(engine.Command(R"({"method":"evaluate","source":"[typeof sourceDocument,forbiddenDocument,typeof desktopApi]"})")) ==
          "[\"undefined\",true,\"object\"]", "Authorized navigation did not create a fresh document");
    std::cout << "Desktop navigation requires browser authorization before author redirect execution\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}

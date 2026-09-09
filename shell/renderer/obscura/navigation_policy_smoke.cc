// SPDX-License-Identifier: Apache-2.0
#include "obscura_engine.h"
#include "http_redirect_fixture.h"
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
    // The pinned engine's existing explicit opt-in applies only to this test
    // process; both fixture listeners bind exclusively to loopback.
    PrivateNetworkTestOptIn allow_test_loopback;
    HttpRedirectFixture http;
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
    const std::string preload = R"({"method":"configurePreload","source":"const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('httpProbe',{token:'preload-ok'});"})";
    engine.Command(preload);
    const auto same = Text(engine.Command("{\"method\":\"loadURL\",\"url\":\"" + http.First("/same-redirect") + "\"}"));
    Check(same.find(http.First("/same-final")) != std::string::npos,
          "Same-origin HTTP redirect did not reach its final URL");
    Check(Text(engine.Command(R"({"method":"evaluate","source":"[httpAuthor,httpProbe.token]"})")) ==
          "[\"same-origin\",\"preload-ok\"]", "Same-origin destination did not run with its preload");

    auto reject_cross_origin = [&] {
      bool rejected = false;
      try { engine.Command("{\"method\":\"loadURL\",\"url\":\"" + http.First("/cross-redirect") + "\"}"); }
      catch (const std::runtime_error& error) {
        rejected = std::string(error.what()).find("Cross-origin HTTP redirect requires browser authorization") != std::string::npos;
        if (!rejected) throw;
      }
      Check(rejected, "Cross-origin HTTP redirect was executed without authorization");
      Check(Text(engine.Command(R"({"method":"getState"})")).find("\"loaded\":false") != std::string::npos,
            "Rejected navigation remained capture/evaluation-ready");
    };
    reject_cross_origin();
    Check(http.destination_requests() == 1,
          "Test did not exercise the actual cross-origin HTTP destination response");
    Check(http.author_requests() == 0, "Cross-origin destination author code executed");

    // An unmistakable preload failure must not replace the earlier redirect
    // policy error: authorization is checked before installing that preload.
    engine.Command(R"json({"method":"configurePreload","source":"throw new Error('DESTINATION_PRELOAD_EXECUTED')"})json");
    reject_cross_origin();
    Check(http.destination_requests() == 2, "Second redirect did not reach the HTTP response guard");
    Check(http.author_requests() == 0, "Rejected target produced an author-script network effect");

    // A failed redirect must not poison the engine or leave target document
    // state in the next explicitly approved navigation.
    engine.Command(preload);
    engine.Command("{\"method\":\"loadURL\",\"url\":\"" + http.First("/same-final") + "\"}");
    Check(Text(engine.Command(R"({"method":"evaluate","source":"[httpAuthor,httpProbe.token,typeof crossOriginAuthorRan]"})")) ==
          "[\"same-origin\",\"preload-ok\",\"undefined\"]", "Engine did not recover cleanly after redirect rejection");
    Check(!http.failed(), "Local HTTP fixture failed");
    std::cout << "Desktop navigation: author deferral, same-origin HTTP redirect, cross-origin rejection before preload/author code, and recovery passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}

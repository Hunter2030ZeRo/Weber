// SPDX-License-Identifier: Apache-2.0
#include "renderer_process.h"
#include "../../common/obscura/wire.h"
#include <cerrno>
#include <csignal>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
using electron::obscura::RendererProcess;
using namespace std::chrono_literals;
void Check(bool value, const char* text) { if (!value) throw std::runtime_error(text); }
std::string Text(const std::vector<uint8_t>& bytes) { return {bytes.begin(), bytes.end()}; }
template<class F> void Fails(F&& fn) {
  bool failed = false;
  try { fn(); } catch (const std::exception&) { failed = true; }
  Check(failed, "Expected failure");
}
void Reaped(int pid) {
  int status = 0; errno = 0;
  Check(waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD, "Child was not reaped");
}
void Real(const std::string& path) {
  std::ofstream("process-smoke.html") << "<!doctype html><body style='background:red'><h1>Separate Obscura renderer</h1>";
  auto first = std::make_unique<RendererProcess>(path);
  RendererProcess second(path);
  const int first_pid = first->process_id(), second_pid = second.process_id();
  Check(first_pid != second_pid && first_pid != getpid() && second_pid != getpid(), "Renderer process identity mismatch");
  const std::string load = R"json({"method":"loadFile","path":"process-smoke.html"})json";
  const std::string query = R"json({"method":"evaluate","source":"document.querySelector('h1').textContent"})json";
  first->Command(load); second.Command(load);
  Check(Text(first->Command(query)) == "\"Separate Obscura renderer\"", "Real DOM mismatch");
  first->Command(R"json({"method":"evaluate","source":"document.querySelector('h1').textContent='changed'; null"})json");
  Check(Text(second.Command(query)) == "\"Separate Obscura renderer\"", "Renderer documents leaked");
  first->Command(R"json({"method":"evaluate","source":"globalThis.idleTimer=0; setTimeout(()=>globalThis.idleTimer=123,20); null"})json");
  std::this_thread::sleep_for(300ms);
  Check(std::stod(Text(first->Command(R"json({"method":"evaluate","source":"globalThis.idleTimer"})json"))) == 123.0,
        "Renderer timer did not progress while browser was idle");
  const auto png = first->Command(R"json({"method":"capturePng"})json");
  Check(png.size() > 100 && png[0] == 137 && png[1] == 'P' && png[2] == 'N' && png[3] == 'G', "Missing renderer pixels");
  Fails([&] { first->Command(R"json({"method":"evaluate","source":"throw new Error('visible failure')"})json"); });
  Check(Text(first->Command(query)) == "\"changed\"", "Application error corrupted transport");
  kill(first_pid, SIGKILL);
  Fails([&] { first->Command(query); });
  first.reset(); Reaped(first_pid);
  Check(Text(second.Command(query)) == "\"Separate Obscura renderer\"", "Other renderer died after peer crash");
  RendererProcess replacement(path);
  replacement.Command(load);
  Check(Text(replacement.Command(query)) == "\"Separate Obscura renderer\"", "Renderer replacement failed");
  std::cout << "Real separate-process Obscura DOM, PNG, document isolation, crash containment and replacement passed\n";
}
void Fake(const std::string& fixture) {
  char pattern[] = "/tmp/weber-process-test-XXXXXX";
  char* directory = mkdtemp(pattern);
  Check(directory != nullptr, "mkdtemp failed");
  const std::filesystem::path root(directory);
  try {
    Fails([&] { RendererProcess missing("/does-not-exist/weber-renderer", 100ms); });
    for (const std::string mode : {"bad-start", "stall-start", "exit", "stall", "wrong-id", "oversize", "fragment"}) {
      const auto executable = root / mode;
      std::filesystem::create_symlink(fixture, executable);
      const auto start = std::chrono::steady_clock::now();
      if (mode == "bad-start" || mode == "stall-start") {
        Fails([&] { RendererProcess process(executable.string(), 200ms); });
      } else {
        int pid = -1;
        {
          RendererProcess process(executable.string(), 200ms); pid = process.process_id();
          // A local rejection must not send bytes or break the connection.
          Fails([&] { process.Command(std::string(electron::obscura::wire::kMaxRequest + 1, 'x')); });
          if (mode == "fragment") Check(Text(process.Command("{}")) == "ok", "Fragmented response mismatch");
          else {
            Fails([&] { process.Command("{}"); });
            Fails([&] { process.Command("{}"); });
          }
        }
        Reaped(pid);
      }
      Check(std::chrono::steady_clock::now() - start < 3s, "Unbounded renderer failure");
    }
    // Descriptor remapping must also work in a process with no stdio handles.
    const pid_t probe = fork();
    Check(probe >= 0, "fork failed");
    if (probe == 0) {
      close(0); close(1); close(2);
      try {
        { RendererProcess process((root / "fragment").string(), 200ms);
          if (Text(process.Command("{}")) != "ok") _exit(10); }
        _exit(0);
      } catch (...) { _exit(11); }
    }
    int status = 0;
    Check(waitpid(probe, &status, 0) == probe && WIFEXITED(status) && WEXITSTATUS(status) == 0,
          "Renderer descriptor remapping failed with closed stdio");
  } catch (...) { std::filesystem::remove_all(root); throw; }
  std::filesystem::remove_all(root);
  std::cout << "Transport deadlines, startup failures, frame bounds, sequence checks, fragmentation and child cleanup passed\n";
}
int main(int argc, char** argv) {
  try {
    if (argc != 3) return 2;
    if (std::string(argv[1]) == "--fake") Fake(std::filesystem::absolute(argv[2]).string());
    else if (std::string(argv[1]) == "--real") Real(std::filesystem::absolute(argv[2]).string());
    else return 2;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}

// SPDX-License-Identifier: Apache-2.0
#include "obscura_engine.h"
#include "../../common/obscura/wire.h"
#include <cstring>
#include <cstdlib>
#include <cerrno>
#include <poll.h>
#include <csignal>
#include <iostream>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc, char** argv) {
  using namespace electron::obscura;
  if ((argc != 2 && argc != 3) || std::strcmp(argv[1], "--weber-channel=3")) return 2;
  const bool notifications = argc == 3 && std::strcmp(argv[2], "--weber-notifications") == 0;
  if (argc == 3 && !notifications) return 2;
  // Do not leave an engine process behind if its owning desktop host is killed.
  const pid_t parent = getppid();
  if (parent == 1 || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) return 2;
  int type = 0; socklen_t length = sizeof(type);
  if (getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &length) || type != SOCK_STREAM) return 2;
  try {
    int resource_type = 0; socklen_t resource_length = sizeof(resource_type);
    const bool has_resources = getsockopt(4, SOL_SOCKET, SO_TYPE, &resource_type, &resource_length) == 0 && resource_type == SOCK_STREAM;
    // Network.getResponseBody copies are diagnostic retention, separate from
    // the browser resource cache. No desktop debugger consumes them by default.
    // An explicit embedder setting can opt back in for engine diagnostics.
    if (!std::getenv("OBSCURA_NETWORK_BODY_BUFFER_ENTRIES"))
      setenv("OBSCURA_NETWORK_BODY_BUFFER_ENTRIES", "0", 0);
    ObscuraEngine engine(has_resources ? 4 : -1);
    wire::Send(3, {0, wire::kReady, {'1'}}, std::chrono::steady_clock::now() + std::chrono::seconds(5));
    uint32_t sequence = 0;
    bool frame_pending = false;
    auto drain_events = [&] {
      if (!notifications) return;
      auto events = engine.Command(R"({"method":"pollEvents"})");
      const std::string empty = R"({"dropped":0,"events":[]})";
      if (std::string(events.begin(), events.end()) != empty)
        wire::Send(3, {0, wire::kEvents, std::move(events)}, std::chrono::steady_clock::now() + std::chrono::seconds(30));
    };
    for (;;) {
      const int work = engine.Wait(3, notifications && !frame_pending);
      if (work == 1) { drain_events(); continue; }
      if (work == 2) {
        frame_pending = true;
        wire::Send(3, {0, wire::kFrameReady, {}}, std::chrono::steady_clock::now() + std::chrono::seconds(30));
        continue;
      }
      auto request = wire::Receive(3, wire::kMaxRequest, wire::Deadline::max());
      if (request.kind != wire::kRequest || !request.sequence || request.sequence != sequence + 1) return 3;
      sequence = request.sequence;
      wire::Frame response{sequence, wire::kSuccess, {}};
      try {
        const std::string command(request.payload.begin(), request.payload.end());
        // Only the owner emits this exact internal command. A notification
        // stays outstanding until its corresponding frame request is consumed.
        if (command == R"({"method":"captureFrameIfChanged"})") frame_pending = false;
        response.payload = engine.Command(command);
      }
      catch (const std::exception& error) {
        response.kind = wire::kError;
        const std::string message = error.what();
        response.payload.assign(message.begin(), message.end());
      }
      wire::Send(3, response, std::chrono::steady_clock::now() + std::chrono::seconds(30));
      drain_events();
    }
  } catch (const std::exception& error) {
    std::cerr << "Obscura renderer stopped: " << error.what() << '\n';
    close(3); return 1;
  }
}

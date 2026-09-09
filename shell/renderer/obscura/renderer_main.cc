// SPDX-License-Identifier: Apache-2.0
#include "obscura_engine.h"
#include "../../common/obscura/wire.h"
#include <cstring>
#include <iostream>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc, char** argv) {
  using namespace electron::obscura;
  if (argc != 2 || std::strcmp(argv[1], "--weber-channel=3")) return 2;
  int type = 0; socklen_t length = sizeof(type);
  if (getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &length) || type != SOCK_STREAM) return 2;
  try {
    ObscuraEngine engine;
    wire::Send(3, {0, wire::kReady, {'1'}}, std::chrono::steady_clock::now() + std::chrono::seconds(5));
    uint32_t sequence = 0;
    for (;;) {
      auto request = wire::Receive(3, wire::kMaxRequest, wire::Deadline::max());
      if (request.kind != wire::kRequest || !request.sequence || request.sequence != sequence + 1) return 3;
      sequence = request.sequence;
      wire::Frame response{sequence, wire::kSuccess, {}};
      try { response.payload = engine.Command(std::string(request.payload.begin(), request.payload.end())); }
      catch (const std::exception& error) {
        response.kind = wire::kError;
        const std::string message = error.what();
        response.payload.assign(message.begin(), message.end());
      }
      wire::Send(3, response, std::chrono::steady_clock::now() + std::chrono::seconds(30));
    }
  } catch (const std::exception& error) {
    std::cerr << "Obscura renderer stopped: " << error.what() << '\n';
    close(3); return 1;
  }
}

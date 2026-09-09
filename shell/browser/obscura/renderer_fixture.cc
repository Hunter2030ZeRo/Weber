// SPDX-License-Identifier: Apache-2.0
// Protocol failure fixture only. Does not emulate Obscura.
#include "../../common/obscura/wire.h"
#include <array>
#include <filesystem>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc, char** argv) {
  using namespace electron::obscura;
  if (argc != 2) return 2;
  const auto mode = std::filesystem::path(argv[0]).filename().string();
  if (mode == "stall-start") { for (;;) pause(); }
  wire::Send(3, {0, wire::kReady, {static_cast<uint8_t>(mode == "bad-start" ? '2' : '1')}}, wire::Deadline::max());
  auto request = wire::Receive(3, wire::kMaxRequest, wire::Deadline::max());
  if (mode == "exit") return 7;
  if (mode == "stall") { for (;;) pause(); }
  if (mode == "oversize") {
    std::array<uint8_t, 16> header{'W','B','R','1',0,0,0,1,0,0,0,1,4,0,0,1};
    if (send(3, header.data(), header.size(), MSG_NOSIGNAL) != 16) return 3;
  } else if (mode == "fragment") {
    std::array<uint8_t, 18> frame{'W','B','R','1',0,0,0,1,0,0,0,1,0,0,0,2,'o','k'};
    for (const auto byte : frame) if (send(3, &byte, 1, MSG_NOSIGNAL) != 1) return 3;
  } else {
    wire::Send(3, {request.sequence + 1, wire::kSuccess, {}}, wire::Deadline::max());
  }
  return 0;
}

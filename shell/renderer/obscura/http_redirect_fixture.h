// SPDX-License-Identifier: Apache-2.0
// Bounded, loopback-only HTTP fixture; no external services or fixed ports.
#ifndef WEBER_HTTP_REDIRECT_FIXTURE_H_
#define WEBER_HTTP_REDIRECT_FIXTURE_H_
#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

class PrivateNetworkTestOptIn final {
 public:
  PrivateNetworkTestOptIn() {
    if (const char* value = std::getenv("OBSCURA_ALLOW_PRIVATE_NETWORK")) previous_ = value;
    if (setenv("OBSCURA_ALLOW_PRIVATE_NETWORK", "1", 1))
      throw std::runtime_error("Cannot configure loopback-only HTTP test");
  }
  ~PrivateNetworkTestOptIn() {
    if (previous_) setenv("OBSCURA_ALLOW_PRIVATE_NETWORK", previous_->c_str(), 1);
    else unsetenv("OBSCURA_ALLOW_PRIVATE_NETWORK");
  }
  PrivateNetworkTestOptIn(const PrivateNetworkTestOptIn&) = delete;
  PrivateNetworkTestOptIn& operator=(const PrivateNetworkTestOptIn&) = delete;
 private:
  std::optional<std::string> previous_;
};

class HttpRedirectFixture final {
 public:
  HttpRedirectFixture() {
    try {
      first_ = Listen(first_port_);
      second_ = Listen(second_port_);
      worker_ = std::thread([this] { Run(); });
    } catch (...) {
      if (first_ >= 0) close(first_);
      if (second_ >= 0) close(second_);
      throw;
    }
  }
  ~HttpRedirectFixture() {
    stopping_ = true;
    shutdown(first_, SHUT_RDWR);
    shutdown(second_, SHUT_RDWR);
    if (worker_.joinable()) worker_.join();
    close(first_);
    close(second_);
  }
  HttpRedirectFixture(const HttpRedirectFixture&) = delete;
  HttpRedirectFixture& operator=(const HttpRedirectFixture&) = delete;
  std::string First(const std::string& path) const { return Url(first_port_, path); }
  std::string Second(const std::string& path) const { return Url(second_port_, path); }
  unsigned destination_requests() const { return destination_requests_; }
  unsigned author_requests() const { return author_requests_; }
  bool failed() const { return failed_; }

 private:
  static std::string Url(uint16_t port, const std::string& path) {
    return "http://127.0.0.1:" + std::to_string(port) + path;
  }
  static int Listen(uint16_t& port) {
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) throw std::runtime_error("HTTP fixture socket failed");
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    socklen_t size = sizeof(address);
    if (bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) ||
        listen(fd, 8) || getsockname(fd, reinterpret_cast<sockaddr*>(&address), &size)) {
      close(fd);
      throw std::runtime_error("HTTP fixture listen failed");
    }
    port = ntohs(address.sin_port);
    return fd;
  }
  bool Ready(int fd, short events, std::chrono::steady_clock::time_point deadline) {
    while (!stopping_ && std::chrono::steady_clock::now() < deadline) {
      pollfd item{fd, events, 0};
      const int result = poll(&item, 1, 25);
      if (result < 0 && errno == EINTR) continue;
      if (result < 0 || item.revents & (POLLERR | POLLNVAL)) return false;
      if (result > 0 && item.revents & events) return true;
      if (result > 0 && item.revents & POLLHUP) return false;
    }
    return false;
  }
  void Serve(int fd, bool second) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    std::string request;
    char buffer[1024];
    while (request.find("\r\n\r\n") == std::string::npos && request.size() < 8192) {
      if (!Ready(fd, POLLIN, deadline)) return;
      const auto size = recv(fd, buffer, sizeof(buffer), MSG_DONTWAIT);
      if (size < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
      if (size <= 0) return;
      request.append(buffer, static_cast<size_t>(size));
    }
    const auto begin = request.find(' '), end = request.find(' ', begin + 1);
    if (begin == std::string::npos || end == std::string::npos)
      throw std::runtime_error("Invalid HTTP fixture request");
    const auto path = request.substr(begin + 1, end - begin - 1);
    std::string status = "200 OK", headers, body;
    if (!second && path == "/same-redirect") {
      status = "302 Found";
      headers = "Location: /same-final\r\n";
    } else if (!second && path == "/same-final") {
      body = "<!doctype html><html><body><script>globalThis.httpAuthor='same-origin';</script></body></html>";
    } else if (!second && path == "/cross-redirect") {
      status = "302 Found";
      headers = "Location: " + Second("/cross-final") + "\r\n";
    } else if (second && path == "/cross-final") {
      ++destination_requests_;
      body = "<!doctype html><html><body><script>globalThis.crossOriginAuthorRan=true;fetch('/author-ran');</script></body></html>";
    } else if (second && path == "/author-ran") {
      ++author_requests_;
      body = "unexpected author execution";
    } else {
      status = "404 Not Found";
      body = "No fixture route";
    }
    const std::string reply = "HTTP/1.1 " + status + "\r\n" + headers +
        "Content-Type: text/html; charset=utf-8\r\nContent-Length: " +
        std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
    size_t sent = 0;
    while (sent < reply.size()) {
      if (!Ready(fd, POLLOUT, deadline)) return;
      const auto size = send(fd, reply.data() + sent, reply.size() - sent, MSG_DONTWAIT | MSG_NOSIGNAL);
      if (size < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
      if (size <= 0) return;
      sent += static_cast<size_t>(size);
    }
  }
  void Run() noexcept {
    try {
      while (!stopping_) {
        pollfd listeners[2] = {{first_, POLLIN, 0}, {second_, POLLIN, 0}};
        const int result = poll(listeners, 2, 25);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0) throw std::runtime_error("HTTP fixture poll failed");
        for (size_t i = 0; i < 2 && !stopping_; ++i) {
          if (!(listeners[i].revents & POLLIN)) continue;
          int fd = accept(listeners[i].fd, nullptr, nullptr);
          if (fd < 0 && errno == EINTR) continue;
          if (fd < 0) throw std::runtime_error("HTTP fixture accept failed");
          try { Serve(fd, i == 1); }
          catch (...) { close(fd); throw; }
          close(fd);
        }
      }
    } catch (...) { failed_ = true; }
  }
  int first_ = -1, second_ = -1;
  uint16_t first_port_ = 0, second_port_ = 0;
  std::atomic<bool> stopping_{false}, failed_{false};
  std::atomic<unsigned> destination_requests_{0}, author_requests_{0};
  std::thread worker_;
};
#endif

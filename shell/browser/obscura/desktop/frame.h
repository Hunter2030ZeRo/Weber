// SPDX-License-Identifier: Apache-2.0
#ifndef WEBER_DESKTOP_FRAME_H_
#define WEBER_DESKTOP_FRAME_H_
#include <cairo.h>
#include <cstdint>
#include <memory>
#include <utility>
#include <vector>
namespace weber::desktop {
// One immutable allocation shared by the native view and captures. A separate
// Cairo surface is made for each user; surface objects never cross threads.
class Frame {
 public:
  static std::shared_ptr<const Frame> FromRgba(std::vector<uint8_t> bytes);
  uint32_t width() const { return width_; }
  uint32_t height() const { return height_; }
  cairo_surface_t* Surface() const;
  std::vector<uint8_t> Png() const;
 private:
  Frame(uint32_t width, uint32_t height, std::vector<uint8_t> bytes)
      : width_(width), height_(height), bytes_(std::move(bytes)) {}
  uint32_t width_, height_;
  std::vector<uint8_t> bytes_;
};
}
#endif

// SPDX-License-Identifier: Apache-2.0
#include "frame.h"
#include <cstring>
#include <stdexcept>
namespace weber::desktop {
std::shared_ptr<const Frame> Frame::FromRgba(std::vector<uint8_t> bytes) {
  if (bytes.size() < 12 || std::memcmp(bytes.data(), "OBF1", 4))
    throw std::runtime_error("Invalid raw Obscura frame header");
  const auto read = [](const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
  };
  const auto width = read(bytes.data() + 4), height = read(bytes.data() + 8);
  if (!width || !height || width > 8192 || height > 8192 || uint64_t(width) * height > 16000000 ||
      bytes.size() != 12 + uint64_t(width) * height * 4)
    throw std::runtime_error("Invalid raw Obscura frame dimensions");
  for (size_t i = 12; i < bytes.size(); i += 4) {
    const uint32_t argb = uint32_t(bytes[i+3]) << 24 | uint32_t(bytes[i]) << 16 |
        uint32_t(bytes[i+1]) << 8 | uint32_t(bytes[i+2]);
    std::memcpy(bytes.data() + i, &argb, 4);
  }
  return std::shared_ptr<const Frame>(new Frame(width, height, std::move(bytes)));
}
cairo_surface_t* Frame::Surface() const {
  // Cairo's constructor has no const overload. Our callers only read/present
  // this surface; no drawing context ever targets these immutable frame bytes.
  auto* surface = cairo_image_surface_create_for_data(const_cast<uint8_t*>(bytes_.data()) + 12,
      CAIRO_FORMAT_ARGB32, static_cast<int>(width_), static_cast<int>(height_), static_cast<int>(width_ * 4));
  if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
    cairo_surface_destroy(surface);
    throw std::runtime_error("Native frame surface allocation failed");
  }
  return surface;
}
std::vector<uint8_t> Frame::Png() const {
  std::unique_ptr<cairo_surface_t, decltype(&cairo_surface_destroy)> surface(Surface(), cairo_surface_destroy);
  std::vector<uint8_t> result;
  const auto status = cairo_surface_write_to_png_stream(surface.get(),
    [](void* state, const unsigned char* bytes, unsigned length) noexcept -> cairo_status_t {
      auto& output = *static_cast<std::vector<uint8_t>*>(state);
      if (output.size() + length > 64 * 1024 * 1024) return CAIRO_STATUS_WRITE_ERROR;
      try { output.insert(output.end(), bytes, bytes + length); }
      catch (...) { return CAIRO_STATUS_WRITE_ERROR; }
      return CAIRO_STATUS_SUCCESS;
    }, &result);
  if (status != CAIRO_STATUS_SUCCESS) throw std::runtime_error("Native PNG encoding failed");
  return result;
}
}

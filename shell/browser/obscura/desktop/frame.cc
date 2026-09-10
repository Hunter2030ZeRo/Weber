// SPDX-License-Identifier: Apache-2.0
#include "frame.h"
#include <cstring>
#include <png.h>
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
  struct Encoding { std::vector<uint8_t> output, row; };
  // Heap-owned state survives libpng's longjmp error path. No C++ object with
  // a destructor is created between setjmp and any libpng call.
  const auto state = std::make_unique<Encoding>();
  state->row.resize(width_ * 4);
  auto* png = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (!png) throw std::runtime_error("PNG writer allocation failed");
  auto* info = png_create_info_struct(png);
  if (!info) { png_destroy_write_struct(&png, nullptr); throw std::runtime_error("PNG header allocation failed"); }
  if (setjmp(png_jmpbuf(png))) {
    png_destroy_write_struct(&png, &info);
    throw std::runtime_error("Native PNG encoding failed");
  }
  png_set_write_fn(png, state.get(), [](png_structp writer, png_bytep data, png_size_t length) {
    auto* state = static_cast<Encoding*>(png_get_io_ptr(writer));
    bool failed = length > 64 * 1024 * 1024 - state->output.size();
    if (!failed) {
      try { state->output.insert(state->output.end(), data, data + length); }
      catch (...) { failed = true; }
    }
    if (failed) png_error(writer, "PNG output exceeds the allocation budget");
  }, [](png_structp) {});
  png_set_IHDR(png, info, width_, height_, 8, PNG_COLOR_TYPE_RGBA, PNG_INTERLACE_NONE,
    PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
  // Screen capture favors latency. This changes compression, never pixels.
  png_set_compression_level(png, 1);
  png_set_filter(png, PNG_FILTER_TYPE_BASE, PNG_FILTER_SUB);
  png_write_info(png, info);
  for (uint32_t y = 0; y < height_; ++y) {
    for (uint32_t x = 0; x < width_; ++x) {
      uint32_t pixel;
      std::memcpy(&pixel, bytes_.data() + 12 + (size_t(y) * width_ + x) * 4, 4);
      const auto alpha = pixel >> 24;
      for (unsigned channel = 0; channel < 3; ++channel) {
        const auto value = (pixel >> (16 - channel * 8)) & 255;
        state->row[x * 4 + channel] = alpha == 255 ? value : alpha ? (value * 255 + alpha / 2) / alpha : 0;
      }
      state->row[x * 4 + 3] = alpha;
    }
    png_write_row(png, state->row.data());
  }
  png_write_end(png, info);
  png_destroy_write_struct(&png, &info);
  return std::move(state->output);
}
}

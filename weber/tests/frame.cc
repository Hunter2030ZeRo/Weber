// SPDX-License-Identifier: Apache-2.0
#include "../../shell/browser/obscura/desktop/frame.h"
#include <cstring>
#include <stdexcept>
#include <iostream>
void Check(bool ok) { if (!ok) throw std::runtime_error("Frame pixel test failed"); }
int main() {
  using weber::desktop::Frame;
  auto frame = Frame::FromRgba({'O','B','F','1',2,0,0,0,2,0,0,0,
    255,0,0,255, 0,255,0,255, 0,0,255,255, 64,0,0,128});
  Check(frame->width() == 2 && frame->height() == 2);
  const auto png = frame->Png();
  Check(png == frame->Png());
  struct Reader { const std::vector<uint8_t>& bytes; size_t offset = 0; } reader{png};
  auto* decoded = cairo_image_surface_create_from_png_stream(
    [](void* data, unsigned char* out, unsigned length) -> cairo_status_t {
      auto& reader = *static_cast<Reader*>(data);
      if (reader.offset + length > reader.bytes.size()) return CAIRO_STATUS_READ_ERROR;
      std::memcpy(out, reader.bytes.data() + reader.offset, length); reader.offset += length;
      return CAIRO_STATUS_SUCCESS;
    }, &reader);
  Check(cairo_surface_status(decoded) == CAIRO_STATUS_SUCCESS);
  Check(cairo_image_surface_get_width(decoded) == 2 && cairo_image_surface_get_height(decoded) == 2);
  cairo_surface_flush(decoded);
  const uint32_t expected[] = {0xffff0000, 0xff00ff00, 0xff0000ff, 0x80400000};
  const auto* pixels = cairo_image_surface_get_data(decoded);
  const auto stride = cairo_image_surface_get_stride(decoded);
  for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    uint32_t value; std::memcpy(&value, pixels + y * stride + x * 4, 4);
    Check(value == expected[y * 2 + x]);
  }
  cairo_surface_destroy(decoded);
  bool rejected = false;
  try { Frame::FromRgba({'O','B','F','1',255,255,255,255,1,0,0,0}); }
  catch (const std::exception&) { rejected = true; }
  Check(rejected);
  std::cout << "PASS: immutable frame, pixel order, alpha, repeated PNG capture and bounds\n";
}

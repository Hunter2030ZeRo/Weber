// Copyright Weber contributors. SPDX-License-Identifier: MIT
#pragma once
#include <nlohmann/json.hpp>

namespace weber::desktop {
// Must run on the GTK main thread. Images contain PNG base64 in data and an
// explicit size; an unavailable/disabled thumbnail is the empty image shape.
nlohmann::json DesktopCaptureSources(const nlohmann::json& request);
}

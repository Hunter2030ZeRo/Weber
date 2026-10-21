"""Private test URL handler. Records argv without visiting a network address."""
import json
import os
import sys

if not os.environ.get("WEBER_TEST_DISPLAY", "").startswith("isolated GNOME"):
    raise SystemExit("Use the isolated Wayland harness")
with open(sys.argv[1], "a", encoding="utf8") as output:
    output.write(json.dumps({"url": sys.argv[2]}, ensure_ascii=False) + "\n")

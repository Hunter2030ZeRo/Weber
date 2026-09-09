// An independent X11 client used to prove shortcuts work outside Weber focus.
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <unistd.h>

#include <cstdio>

int main() {
  Display* display = XOpenDisplay(nullptr);
  if (!display) {
    std::fprintf(stderr, "Cannot open X11 display\n");
    return 1;
  }
  const int screen = DefaultScreen(display);
  const Window window = XCreateSimpleWindow(
      display, RootWindow(display, screen), 510, 20, 360, 180, 0,
      BlackPixel(display, screen), WhitePixel(display, screen));
  XStoreName(display, window, "Independent global shortcut focus client");
  const unsigned long pid = static_cast<unsigned long>(getpid());
  const Atom pid_atom = XInternAtom(display, "_NET_WM_PID", False);
  XChangeProperty(display, window, pid_atom, XA_CARDINAL, 32, PropModeReplace,
                  reinterpret_cast<const unsigned char*>(&pid), 1);
  XSelectInput(display, window, StructureNotifyMask | KeyPressMask);
  XMapWindow(display, window);
  XFlush(display);
  unsigned int primary = 0;
  unsigned int secondary = 0;
  bool ready = false;
  while (true) {
    XEvent event;
    XNextEvent(display, &event);
    if (event.type == DestroyNotify) break;
    bool changed = false;
    if (event.type == MapNotify && !ready) {
      ready = true;
      changed = true;
    } else if (event.type == KeyPress) {
      const KeySym symbol = XLookupKeysym(&event.xkey, 0);
      if (symbol == XK_F8) { ++primary; changed = true; }
      if (symbol == XK_F9) { ++secondary; changed = true; }
    }
    if (changed) {
      std::printf("{\"ready\":%s,\"windowId\":%lu,\"pid\":%lu,\"primary\":%u,\"secondary\":%u}\n",
                  ready ? "true" : "false", window, pid, primary, secondary);
      std::fflush(stdout);
    }
  }
  XCloseDisplay(display);
  return 0;
}

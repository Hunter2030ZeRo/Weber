/* Test helper: send the same WM_DELETE_WINDOW protocol as a window manager. */
#include <X11/Xlib.h>
#include <errno.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    char *end = NULL;
    errno = 0;
    unsigned long window = strtoul(argv[1], &end, 10);
    if (errno || !end || *end || !window) return 2;
    Display *display = XOpenDisplay(NULL);
    if (!display) return 3;
    XEvent event = {0};
    event.xclient.type = ClientMessage;
    event.xclient.window = window;
    event.xclient.message_type = XInternAtom(display, "WM_PROTOCOLS", False);
    event.xclient.format = 32;
    event.xclient.data.l[0] = XInternAtom(display, "WM_DELETE_WINDOW", False);
    event.xclient.data.l[1] = CurrentTime;
    int sent = XSendEvent(display, window, False, NoEventMask, &event);
    XSync(display, False);
    XCloseDisplay(display);
    return sent ? 0 : 4;
}

// Test-only virtual keyboard. Refuses non-owned display environments.
#define _GNU_SOURCE
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include "virtual-keyboard-client.h"
static struct wl_seat *seat;
static struct zwp_virtual_keyboard_manager_v1 *manager;
static void global(void *data,struct wl_registry *registry,uint32_t name,const char *iface,uint32_t version) {
    (void)data;(void)version;
    if (!strcmp(iface,"wl_seat")) seat=wl_registry_bind(registry,name,&wl_seat_interface,1);
    if (!strcmp(iface,"zwp_virtual_keyboard_manager_v1")) manager=wl_registry_bind(registry,name,&zwp_virtual_keyboard_manager_v1_interface,1);
}
static void removed(void *data,struct wl_registry *registry,uint32_t name) {(void)data;(void)registry;(void)name;}
static const struct wl_registry_listener listener={global,removed};
int main(void) {
    const char *scope=getenv("WEBER_TEST_DISPLAY"),*runtime=getenv("XDG_RUNTIME_DIR");
    if (!scope || strncmp(scope,"isolated Hyprland",17) || !runtime || strncmp(runtime,"/tmp/wh-",8)) return 2;
    struct wl_display *display=wl_display_connect(NULL); if (!display) return 3;
    struct wl_registry *registry=wl_display_get_registry(display);wl_registry_add_listener(registry,&listener,NULL);
    if(wl_display_roundtrip(display)<0 || !seat || !manager) return 4;
    struct xkb_context *context=xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    struct xkb_rule_names rules={.layout="kr",.variant="kr104"};
    struct xkb_keymap *map=xkb_keymap_new_from_names(context,&rules,XKB_KEYMAP_COMPILE_NO_FLAGS);if(!map)return 5;
    char *text=xkb_keymap_get_as_string(map,XKB_KEYMAP_FORMAT_TEXT_V1);size_t length=strlen(text)+1;
    int fd=memfd_create("weber-test-keymap",MFD_CLOEXEC);if(fd<0 || write(fd,text,length)!=(ssize_t)length)return 6;
    struct zwp_virtual_keyboard_v1 *keyboard=zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager,seat);
    zwp_virtual_keyboard_v1_keymap(keyboard,WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1,fd,(uint32_t)length);
    close(fd);free(text);
    struct xkb_state *state=xkb_state_new(map);
    if(wl_display_roundtrip(display)<0)return 7;
    puts("{\"ready\":true,\"backend\":\"Hyprland virtual-keyboard-v1; compositor/IME input\"}");fflush(stdout);
    char *line=NULL;size_t cap=0;
    while(getline(&line,&cap,stdin)>0) {
        if(strlen(line)>4096)return 8;
        if(strstr(line,"\"stop\":true"))break;
        char *key=strstr(line,"\"keycode\":");if(!key)return 9;
        long code=strtol(key+10,NULL,10);if(code<1 || code>767)return 10;
        int down=strstr(line,"\"pressed\":true")!=NULL;
        struct timespec now;clock_gettime(CLOCK_MONOTONIC,&now);
        xkb_state_update_key(state,(xkb_keycode_t)code+8,down?XKB_KEY_DOWN:XKB_KEY_UP);
        zwp_virtual_keyboard_v1_modifiers(keyboard,xkb_state_serialize_mods(state,XKB_STATE_MODS_DEPRESSED),xkb_state_serialize_mods(state,XKB_STATE_MODS_LATCHED),xkb_state_serialize_mods(state,XKB_STATE_MODS_LOCKED),xkb_state_serialize_layout(state,XKB_STATE_LAYOUT_EFFECTIVE));
        zwp_virtual_keyboard_v1_key(keyboard,(uint32_t)(now.tv_sec*1000+now.tv_nsec/1000000),(uint32_t)code,down?WL_KEYBOARD_KEY_STATE_PRESSED:WL_KEYBOARD_KEY_STATE_RELEASED);
        if(wl_display_roundtrip(display)<0)return 11;
        puts("{\"done\":true}");fflush(stdout);
    }
    free(line);zwp_virtual_keyboard_v1_destroy(keyboard);wl_display_roundtrip(display);wl_display_disconnect(display);
    xkb_state_unref(state);xkb_keymap_unref(map);xkb_context_unref(context);return 0;
}

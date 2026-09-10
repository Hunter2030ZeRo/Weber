// Copyright Weber contributors. SPDX-License-Identifier: Apache-2.0
#ifndef WEBER_ENGINE_ABI_H_
#define WEBER_ENGINE_ABI_H_
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Renderer-side only: do not mix Obscura's V8 with Electron's V8 in one process.
// The request pointer is borrowed. Callback bytes expire when callback returns.
// Callbacks must not throw or reenter. All calls use the creating thread.
typedef void (*weber_engine_reply)(const uint8_t*, size_t, void*);
uint32_t weber_engine_abi_version(void);
uint64_t weber_engine_create(void);
uint64_t weber_engine_create_with_resources(int32_t);
int32_t weber_engine_command(uint64_t, const uint8_t*, size_t, weber_engine_reply, void*);
int32_t weber_engine_destroy(uint64_t);
#ifdef __cplusplus
}
#endif
#endif

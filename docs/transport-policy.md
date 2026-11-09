# Process boundaries and data transport

Approved direction, 2026-11-09. This is the transport policy for subsequent
framework work; the existing JSON backend protocol has not been replaced by a
shared-memory implementation.

| Boundary / data | Preferred path |
| --- | --- |
| Components in one process | Direct calls and shared owned data; do not add IPC or a new process solely to connect framework modules |
| Isolation is required; small control messages | Bounded pipes for request IDs, operation/region identifiers, offsets/lengths, errors, completion, cancellation and lifecycle |
| Isolation is required; large mutable or streaming data | Shared memory with explicit ownership, synchronization, bounded regions and backpressure |
| File-backed / mostly immutable data | File memory mappings where appropriate; do not serialize entire files as JSON/base64 messages |

Avoid avoidable process boundaries before optimizing their transport. A renderer,
extension host or worker may still need a boundary for isolation, fault handling
or runtime compatibility. Do not remove a justified boundary merely to reduce a
message count. A memory mapping alone does not establish safe sharing or zero
copy across every JS/runtime/GPU boundary.

For the future isolated transport, prefer establishing shared-region handles at
process startup, then referring to bounded slices through the control pipes.
Platform-specific handle creation/transfer must stay behind a common contract;
Linux-only mechanisms must not leak into application JS APIs. Dynamic handle
transfer still needs a concrete platform design before implementation.

Every region needs an owner, capacity, access permissions and generation; slice
offsets and lengths must be checked against the mapped capacity. Define the
producer/consumer handoff, synchronization, close/cancel behavior and process-death
reclamation. Avoid serializing a large payload or copying it repeatedly just to
enter and leave the shared region. File mappings must retain file identity and
integrity/path guarantees; concurrent truncation/replacement must have defined
behavior. Do not blindly map arbitrary paths supplied by an untrusted renderer.

Acceptance must measure actual copies, latency and retained mapped memory on a
representative workload, with bounded queues, cancellation, repeated close and
crashed-peer tests. Do not call the JSON protocol zero-copy, or treat browser
ArrayBuffer transfer as proof of a native shared-memory backend.

The Range geometry increment uses Servo's existing in-process layout trait and
shared shaped text/scroll-tree data. It adds no new process or pipe protocol and
does not mirror the DOM or reserialize glyph data into an external service.

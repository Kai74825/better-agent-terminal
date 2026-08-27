# Headless server resource guardrails

Status: implemented and locally verified; not yet released or deployed.

## Incident summary

A long-running headless instance remained `active (running)` in systemd while
its WebSocket endpoint stopped responding. The TCP listen queue was saturated,
TLS handshakes timed out, and established sockets included stale
`CLOSE-WAIT` connections. Restarting the service restored TCP, TLS, and an
authenticated WebSocket connection without changing the token or certificate
fingerprint.

The journal provides direct evidence of task pressure: on multiple days the
same service emitted `failed to spawn thread: Resource temporarily unavailable`
from `notify-rs inotify loop`. The code review found three unbounded resource
paths:

1. Every filesystem notification spawned a new sleeping debounce thread.
2. Every accepted TCP connection and every remote invoke spawned an unbounded
   OS thread.
3. Every remote client used an unbounded outbound event channel, while socket
   writes had no timeout.

The journal proves resource exhaustion occurred, and the code proves those
unbounded paths existed. It does not identify one individual request as the
sole cause of the final listen-queue stall, so the exact last trigger remains
an inference rather than a confirmed fact.

## Implemented changes

| Area | Before | Now |
| --- | --- | --- |
| Filesystem debounce | One thread per notification | One capacity-one queue and one debounce worker per watched directory |
| Filesystem watchers | Unlimited | 64 active/pending watchers, released with RAII |
| TCP handlers | Unlimited, infallible `thread::spawn` | 64 slots and fallible named thread creation |
| Remote invokes | Unlimited, infallible `thread::spawn` | 128 shared slots; overload returns a retryable invoke error |
| Client output | Unbounded channel | 256-frame bounded queue; a saturated client is revoked |
| Socket writes | No timeout | 10-second write timeout |
| Accept errors | Any non-`WouldBlock` error killed the loop silently | Recoverable retry with a 250 ms delay and rate-limited operational log |
| Headless supervision | Main thread parked forever | Accept-loop liveness checked every second; unexpected exit returns failure |
| Diagnostics | Connected-client list only | Acceptor state, active counts, and configured limits in server status |

No connection URL, authentication, TLS pinning, IPC channel, or renderer event
shape changed.

## Verification completed

```text
pnpm run check:tauri-rust
cargo check --manifest-path src-tauri/Cargo.toml --bin bat-server \
  --no-default-features --features headless
cargo build --manifest-path src-tauri/Cargo.toml --bin bat-server \
  --no-default-features --features headless
pnpm run test:tauri-rust
pnpm exec tsc --noEmit --pretty false
pnpm run compile
```

Rust result: 475 passed, 0 failed, 1 existing environment-sensitive test
ignored. New regression coverage verifies watcher-slot release, burst
coalescing, remote resource-slot release, and slow-client revocation. A local
headless binary smoke test also completed TLS 1.3, WebSocket upgrade, and v2
authentication using a temporary data directory and test-only token.

## Release and deployment plan

1. Build the static headless artifact from the reviewed commit using the normal
   release workflow. Do not build a production artifact from a dirty tree.
2. Record the current binary path/version, service unit, token-file path,
   certificate fingerprint, and release symlink before changing anything.
3. Extract the new artifact into a new versioned release directory. Do not
   overwrite the running binary in place.
4. Point the release symlink at the new directory, run the binary's `--help` or
   version smoke check, then restart the service once.
5. Validate in order: systemd active, listener present, local TLS handshake,
   tunnel TLS handshake, authenticated WebSocket open, and one harmless status
   invoke.
6. Confirm that the token and TLS fingerprint are unchanged. If either changes,
   stop and investigate the data-directory/service-user configuration.
7. Monitor for at least one normal work cycle:
   - task/thread count and cgroup `TasksCurrent`;
   - listen `Recv-Q` versus `Send-Q`;
   - `CLOSE-WAIT` count;
   - `Resource temporarily unavailable`, capacity, accept, and thread-start
     log messages;
   - successful reconnect after intentionally closing one client.

## Rollback

1. Repoint the release symlink to the recorded previous release directory.
2. Restart the service.
3. Re-run the TCP/TLS/authenticated-WebSocket smoke checks.
4. Preserve the failed release and logs for diagnosis; do not delete the token,
   certificate, or application data directory.

The resource limits are compile-time constants in `remote_server.rs` and
`commands/fs.rs`. Change them only with a measured workload and repeat the
slow-client/event-burst tests.

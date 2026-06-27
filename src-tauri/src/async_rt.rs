//! Async runtime shim.
//!
//! On `desktop` this is a transparent re-export of `tauri::async_runtime`, so the
//! desktop build is byte-for-byte unchanged. On the headless build (no tauri) the
//! same three entry points are backed by tokio directly, letting the server core
//! compile and run without linking the GUI stack.
//!
//! `block_on` deliberately uses a dedicated, lazily-built multi-thread runtime
//! (mirroring tauri's global runtime) rather than `Handle::current()`, so it is
//! callable from plain synchronous threads — which is how the headless dispatch
//! invokes it. It must NOT be called from inside a task already running on that
//! runtime (that would panic with "Cannot block the current thread from within a
//! runtime"); the headless server keeps its per-client dispatch on OS threads.

#[cfg(feature = "desktop")]
pub use tauri::async_runtime::{block_on, spawn, spawn_blocking};

#[cfg(not(feature = "desktop"))]
pub use tokio::task::{spawn, spawn_blocking};

#[cfg(not(feature = "desktop"))]
pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::sync::OnceLock;
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let rt = RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build headless async_rt runtime")
    });
    rt.block_on(future)
}

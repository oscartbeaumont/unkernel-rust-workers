//! A tiny Axum hello world that runs in the unkernel guest.
//!
//! The guest is a real aarch64 Linux userland (Alpine-flavored); this binary is
//! built as a fully static musl executable and runs under the base system's
//! init without any distro. It binds loopback port 3000, which the Worker reaches
//! through the kernel's vm.fetch().

use axum::{Router, routing::{get, post}};

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/", get(hello))
        .route("/health", get(health))
        .route("/echo", post(echo));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .expect("failed to bind 127.0.0.1:3000");

    println!("axum-hello: listening on 127.0.0.1:3000");
    axum::serve(listener, app).await.expect("server error");
}

async fn hello() -> &'static str {
    "Hello from unkernel-rs (Rust + Axum on Cloudflare Workers)
"
}

async fn health() -> &'static str {
    "ok\n"
}

async fn echo(body: axum::body::Bytes) -> String {
    // Echo the request body back as text, for the Worker to forward.
    String::from_utf8_lossy(&body).into_owned()
}

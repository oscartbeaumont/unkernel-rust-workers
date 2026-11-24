//! A tiny Axum hello world that runs in the unkernel guest.
//!
//! The binary is built as a fully static musl executable for the guest's own
//! init (guest/init/init.c) and is packed into the kernel's initrd. It binds
//! loopback port 3000, which the Worker reaches through the kernel's
//! vm.fetch().

use axum::{
    http::StatusCode,
    http::Uri,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use std::{
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};

static PARALLELISM: OnceLock<usize> = OnceLock::new();
static CANCELLED_CPU_GENERATION: AtomicU64 = AtomicU64::new(u64::MAX);
static RUNNING_CPU_TASKS: AtomicUsize = AtomicUsize::new(0);

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .max_blocking_threads(4)
        .enable_all()
        .build()
        .expect("failed to build Tokio runtime");
    runtime.block_on(run());
}

async fn run() {
    let app = Router::new()
        .route("/", get(hello))
        .route("/health", get(health))
        .route("/cpu", get(cpu))
        .route("/cpu/cancel", post(cancel_cpu))
        .route("/echo", post(echo));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .expect("failed to bind 127.0.0.1:3000");

    println!("axum-hello: listening on 127.0.0.1:3000");
    axum::serve(listener, app).await.expect("server error");
}

async fn hello() -> &'static str {
    "Hello from unkernel-rust-workers (Rust + Axum on Cloudflare Workers)
"
}

async fn health() -> &'static str {
    "ok\n"
}

/// Run independent CPU jobs and report the guest's usable parallelism. The
/// black-box checksum keeps the optimizer from deleting the work.
async fn cpu(uri: Uri) -> impl IntoResponse {
    let mut jobs = 4usize;
    let mut iterations = 8_000_000u64;
    let mut offset = 0u64;
    let mut generation = 0u64;
    for pair in uri.query().unwrap_or_default().split('&') {
        let mut parts = pair.split('=');
        match parts.next().unwrap_or_default() {
            "jobs" => jobs = parts.next().and_then(|v| v.parse().ok()).unwrap_or(jobs),
            "iterations" => {
                iterations = parts
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(iterations)
            }
            "offset" => offset = parts.next().and_then(|v| v.parse().ok()).unwrap_or(offset),
            "generation" => {
                generation = parts
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(generation)
            }
            _ => {}
        }
    }
    jobs = jobs.clamp(1, 16);
    iterations = iterations.clamp(1, 50_000_000);
    offset = offset.clamp(0, 15);

    let started = Instant::now();
    RUNNING_CPU_TASKS.fetch_add(jobs, Ordering::Relaxed);
    let mut tasks = Vec::with_capacity(jobs);
    for job in 0..jobs {
        tasks.push(tokio::task::spawn_blocking(move || {
            burn_cancellable(
                0x9e3779b97f4a7c15u64 ^ offset.wrapping_add(job as u64),
                iterations,
                generation,
            )
        }));
    }
    let mut checksum = 0u64;
    let mut cancelled = false;
    for task in tasks {
        match task.await.expect("CPU task failed") {
            Some(value) => checksum = checksum.wrapping_add(value),
            None => cancelled = true,
        }
    }
    RUNNING_CPU_TASKS.fetch_sub(jobs, Ordering::Release);
    if cancelled {
        return (
            StatusCode::from_u16(499).expect("valid status code"),
            "cancelled\n",
        )
            .into_response();
    }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    (
        [("cache-control", "no-store")],
        format!(
            "{{\"jobs\":{jobs},\"iterations\":{iterations},\"parallelism\":{},\"elapsedMs\":{elapsed_ms:.3},\"checksum\":\"{checksum}\"}}\n",
            *PARALLELISM.get_or_init(|| {
                std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
            }),
        ),
    ).into_response()
}

async fn cancel_cpu(uri: Uri) -> &'static str {
    let mut generation = 0u64;
    for pair in uri.query().unwrap_or_default().split('&') {
        let mut parts = pair.split('=');
        if parts.next() == Some("generation") {
            generation = parts
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or(generation);
        }
    }
    // Generations are unique per Durable Object. Recording the cancellation
    // before /cpu starts is therefore safe and closes the connect/start race.
    CANCELLED_CPU_GENERATION.store(generation, Ordering::Release);
    // Do not acknowledge cancellation while blocking tasks still burn CPU.
    // The Worker keeps its turn lease until this request completes.
    for _ in 0..100 {
        if RUNNING_CPU_TASKS.load(Ordering::Acquire) == 0 {
            return "ok\n";
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    "timeout\n"
}

#[cfg(test)]
fn burn(state: u64, iterations: u64) -> u64 {
    burn_inner(state, iterations, None, 0).expect("uncancelled burn")
}

fn burn_cancellable(state: u64, iterations: u64, generation: u64) -> Option<u64> {
    burn_inner(
        state,
        iterations,
        Some(&CANCELLED_CPU_GENERATION),
        generation,
    )
}

fn burn_inner(
    mut state: u64,
    mut iterations: u64,
    cancelled: Option<&AtomicU64>,
    generation: u64,
) -> Option<u64> {
    macro_rules! step {
        () => {{
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
        }};
    }

    // The guest is emulated, so each backedge costs a host dispatch too. Keep
    // the same recurrence but amortize that overhead over 256 steps.
    macro_rules! steps8 {
        () => {{
            step!();
            step!();
            step!();
            step!();
            step!();
            step!();
            step!();
            step!();
        }};
    }
    macro_rules! steps64 {
        () => {{
            steps8!();
            steps8!();
            steps8!();
            steps8!();
            steps8!();
            steps8!();
            steps8!();
            steps8!();
        }};
    }
    macro_rules! steps256 {
        () => {{
            steps64!();
            steps64!();
            steps64!();
            steps64!();
        }};
    }

    let mut since_check = 0u32;
    while iterations >= 256 {
        steps256!();
        iterations -= 256;
        since_check += 1;
        if since_check == 16 {
            if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire) == generation) {
                return None;
            }
            since_check = 0;
        }
    }
    while iterations >= 8 {
        steps8!();
        iterations -= 8;
    }
    for _ in 0..iterations {
        step!();
    }
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire) == generation) {
        return None;
    }
    Some(std::hint::black_box(state))
}

async fn echo(body: axum::body::Bytes) -> String {
    // Preserve the existing text contract, including replacement of invalid UTF-8.
    String::from_utf8_lossy(&body).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{burn, burn_cancellable, CANCELLED_CPU_GENERATION};
    use std::sync::atomic::Ordering;

    fn reference(mut state: u64, mut iterations: u64) -> u64 {
        while iterations != 0 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            iterations -= 1;
        }
        state
    }

    #[test]
    fn unrolled_burn_matches_the_original_recurrence() {
        for iterations in [0, 1, 7, 8, 9, 63, 64, 65, 255, 256, 257, 1_000_000] {
            assert_eq!(
                burn(0x9e3779b97f4a7c15, iterations),
                reference(0x9e3779b97f4a7c15, iterations)
            );
        }
    }

    #[test]
    fn four_job_checksum_is_unchanged() {
        let checksum = (0..4).fold(0u64, |sum, job| {
            sum.wrapping_add(burn(0x9e3779b97f4a7c15 ^ job, 1_000_000))
        });
        assert_eq!(checksum.to_string(), "10740750840383687616");
    }

    #[test]
    fn uneven_shard_partitions_cover_each_global_job_once() {
        let direct = (0..10).fold(0u64, |sum, job| {
            sum.wrapping_add(burn(0x9e3779b97f4a7c15 ^ job, 1_000_000))
        });
        let partitioned =
            [3u64, 3, 2, 2]
                .into_iter()
                .enumerate()
                .fold(0u64, |sum, (shard, count)| {
                    let offset = [0u64, 3, 6, 8][shard];
                    sum.wrapping_add((0..count).fold(0u64, |part, job| {
                        part.wrapping_add(burn(
                            0x9e3779b97f4a7c15 ^ offset.wrapping_add(job),
                            1_000_000,
                        ))
                    }))
                });
        assert_eq!(direct, partitioned);
        assert_eq!(direct.to_string(), "12538923296120618574");
    }

    #[test]
    fn cancellation_stops_a_burn_without_changing_other_generations() {
        CANCELLED_CPU_GENERATION.store(777, Ordering::Relaxed);
        assert_eq!(burn_cancellable(123, 10_000_000, 777), None);
        assert!(burn_cancellable(123, 10_000_000, 778).is_some());
        CANCELLED_CPU_GENERATION.store(u64::MAX, Ordering::Relaxed);
    }
}

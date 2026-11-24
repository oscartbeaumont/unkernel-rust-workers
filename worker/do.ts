import { DurableObject } from "cloudflare:workers";
import { createKernel } from "./kernel";
import type { KernelInstance } from "../sdk/index.ts";

const GUEST_FILE = "/hello/axum-hello";
const GUEST_PORT = 3000;
const SHARD_COUNT = 4;
const READY_TIMEOUT_MS = 10_000;
const GUEST_TIMEOUT_MS = 3_000;
const CPU_TIMEOUT_MS = 30_000;
const MAX_BATCH = 16;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_EXCLUSIVE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

interface Guest {
	vm: KernelInstance;
}

interface ExecutionContextLike {
	waitUntil(promise: Promise<unknown>): void;
}

interface Job {
	id: number;
	method: string;
	url: string;
	headers: Headers;
	body?: ArrayBuffer;
	signal: AbortSignal;
	cancelController?: AbortController;
	cancelRequested?: boolean;
	cancelReason?: unknown;
	onCancel?: () => void;
	guest?: Guest;
	cpuGeneration?: number;
	timeoutMs?: number;
	queuedAt: number;
	batchable: boolean;
	attempts: number;
	done: boolean;
	abortListener?: () => void;
	reply?: GuestReply;
	error?: unknown;
	queueMs?: number;
	batch?: number;
}

interface GuestResult {
	status: number;
	statusText: string;
	headers: Array<[string, string]>;
	body: Uint8Array<ArrayBuffer> | null;
	ttfbMs: number;
	bodyMs: number;
}

type GuestReply = Omit<GuestResult, "ttfbMs" | "bodyMs">;

interface CpuResult {
	jobs: number;
	iterations: number;
	parallelism: number;
	elapsedMs: number;
	checksum: string;
}

class GuestError extends Error {
	constructor(
		message: string,
		readonly stage: "headers" | "body",
		readonly clientAborted: boolean,
		options?: ErrorOptions,
		readonly recycle = false,
	) {
		super(message, options);
	}
}

/**
 * One Durable Object owns one kernel and one turn queue. State is deliberately
 * per object: several Durable Objects can share an isolate, so module globals
 * would make their kernels interfere.
 */
class GuestManager {
	private guest?: Guest;
	private bootPromise?: Promise<Guest>;
	private queue: Job[] = [];
	private active: Job[] = [];
	private owner?: Job;
	private readonly cancellable = new Map<string, Job>();
	private nextCpuGeneration = 1;
	private nextJobId = 0;
	private readonly stats = { turns: 0, batched: 0, requests: 0 };

	async handle(request: Request, ctx: ExecutionContextLike): Promise<Response> {
		const url = new URL(request.url);
		let body: ArrayBuffer | undefined;
		try {
			body = await readRequestBody(request);
		} catch (cause) {
			if (cause instanceof RequestTooLargeError) return error(413, cause);
			throw cause;
		}
		const job: Job = {
			id: this.nextJobId++,
			method: request.method,
			url: "http://localhost:" + GUEST_PORT + url.pathname + url.search,
			headers: new Headers(request.headers),
			body,
			signal: request.signal,
			queuedAt: Date.now(),
			batchable: isBatchable(request.method, body),
			attempts: 0,
			done: false,
		};
		job.headers.delete("host");
		this.queue.push(job);
		const abortListener = () => {
			const index = this.queue.indexOf(job);
			if (index >= 0) this.queue.splice(index, 1);
			if (!job.done) {
				job.error = new Error("client disconnected");
				this.finish(job);
			}
		};
		job.abortListener = abortListener;
		job.signal.addEventListener("abort", abortListener, { once: true });
		await this.wait(job, ctx);
		return this.respond(job);
	}

	/** CPU fanout crosses this boundary as a few numbers, not an HTTP message. */
cpu(jobs: number, iterations: number, offset: number, token: string, ctx: ExecutionContextLike): Promise<CpuResult> {
		const controller = new AbortController();
		const generation = this.nextCpuGeneration++;
		const job: Job = {
			id: this.nextJobId++,
			method: "GET",
			url: "http://localhost:" + GUEST_PORT + "/cpu?jobs=" + jobs + "&iterations=" + iterations + "&offset=" + offset + "&generation=" + generation,
			headers: new Headers({ host: "localhost:" + GUEST_PORT }),
			signal: controller.signal,
			cancelController: controller,
			cpuGeneration: generation,
			timeoutMs: CPU_TIMEOUT_MS,
			queuedAt: Date.now(),
			batchable: false,
			attempts: 0,
			done: false,
		};
		const abortListener = () => {
			this.requestCancellation(job, new DOMException("CPU shard cancelled", "AbortError"));
		};
		job.abortListener = abortListener;
		job.signal.addEventListener("abort", abortListener, { once: true });
		this.queue.push(job);
		this.cancellable.set(token, job);
		return this.wait(job, ctx).then(async () => {
			if (!job.reply || job.error) throw job.error ?? new Error("empty CPU response");
			if (!job.reply.body) throw new Error("empty CPU body");
			return JSON.parse(new TextDecoder().decode(job.reply.body)) as CpuResult;
		}).finally(() => {
			if (this.cancellable.get(token) === job) this.cancellable.delete(token);
			job.signal.removeEventListener("abort", abortListener);
		});
	}

	cancel(token: string): Promise<void> {
		const job = this.cancellable.get(token);
		if (!job) return Promise.resolve();
		this.cancellable.delete(token);
		const cancellation = new Error("CPU shard cancelled");
		cancellation.name = "AbortError";
		this.requestCancellation(job, cancellation);
		// Poll inside this RPC invocation. The active driver performs the guest
		// cancel; this request never drives the Wasm stack itself.
		return this.waitForDone(job);
	}

	private requestCancellation(job: Job, reason: unknown): void {
		if (job.done || job.cancelRequested) return;
		job.cancelRequested = true;
		job.cancelReason = reason;
		const index = this.queue.indexOf(job);
		if (index >= 0) {
			this.queue.splice(index, 1);
			job.error = reason;
			this.finish(job);
			return;
		}
		job.onCancel?.();
	}

	private async waitForDone(job: Job): Promise<void> {
		for (let polls = 0; !job.done && polls < 1000; polls++) {
			await new Promise((resolve) => setTimeout(resolve, pollDelay(polls)));
		}
		if (!job.done) throw new Error("CPU cancellation did not release the shard turn");
	}

	/** Called only by the turn owner while its CPU fetch is still pending. */
	private async cancelGuestCpu(job: Job, guest: Guest): Promise<void> {
		if (job.cpuGeneration === undefined) return;
		const generation = job.cpuGeneration;
		await guest.vm.fetch("http://localhost:" + GUEST_PORT + "/cpu/cancel?generation=" + generation, {
			method: "POST",
			headers: { host: "localhost:" + GUEST_PORT },
			signal: AbortSignal.timeout(GUEST_TIMEOUT_MS),
		}).then(async (response) => {
			const text = (await response.text()).trim();
			if (!response.ok || text !== "ok") throw new Error("guest CPU cancel returned " + response.status + ": " + text);
		});
	}

	prewarm(ctx: ExecutionContextLike): Promise<void> {
		return this.ensureBoot(ctx).then(() => {});
	}

	private finish(job: Job): void {
		if (job.done) return;
		job.done = true;
		if (job.abortListener) job.signal.removeEventListener("abort", job.abortListener);
	}

	/** Wait inside this invocation; never leave a request awaiting another request's resolver. */
	private async wait(job: Job, ctx: ExecutionContextLike): Promise<void> {
		while (!this.owner && this.queue[0]?.done) this.queue.shift();
		for (let polls = 0; !job.done; polls++) {
			if (this.queue[0] === job && !this.owner) {
				await this.drive(job, ctx);
				continue;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, pollDelay(polls)));
		}
	}

	private async drive(self: Job, ctx: ExecutionContextLike): Promise<void> {
		if (this.owner || this.queue[0] !== self || self.done) return;
		// Take the turn before the first await. Abort may finish the job, but only
		// this driver releases the lease, so a waiter cannot become a second driver.
		this.owner = self;
		this.active = [self];
		this.queue.shift();
		let guest: Guest;
		try {
			guest = await this.ensureBoot(ctx);
		} catch (error) {
			self.error = error;
			this.finish(self);
			this.release(self);
			return;
		}
		if (!this.owns(self)) {
			this.release(self);
			return;
		}
		self.guest = guest;

		const taken: Job[] = [self];
		if (self.batchable) {
			if (this.queue.length > 1) await new Promise<void>((resolve) => setTimeout(resolve, 1));
			if (!this.owns(self)) {
				this.release(self);
				return;
			}
			for (let index = 0; index < this.queue.length && taken.length < MAX_BATCH; index++) {
				const job = this.queue[index];
				if (!job.batchable || job.signal.aborted) break;
				taken.push(job);
			}
		}
		this.queue = this.queue.filter((job) => !taken.includes(job));

		try {
			this.active = taken;
			const startedAt = Date.now();
			const settled = await Promise.allSettled(
				taken.map((job) => this.run(job, guest, startedAt)),
			);
			this.stats.turns++;
			this.stats.requests += taken.length;
			if (taken.length > 1) this.stats.batched++;

			const retry: Job[] = [];
			for (let index = 0; index < taken.length; index++) {
				const job = taken[index];
				const result = settled[index];
				if (
					result.status === "rejected" &&
					result.reason instanceof GuestError &&
					result.reason.stage === "headers" &&
					!result.reason.clientAborted &&
					!job.done &&
					!job.signal.aborted &&
					job.attempts === 0
				) retry.push(job);
			}
			const forceRecycle = settled.some((result) =>
				result.status === "rejected" && result.reason instanceof GuestError && result.reason.recycle,
			);
			if (forceRecycle) {
				this.recycle(guest, "guest CPU cancellation failed");
				return;
			}
			if (retry.length) {
				for (const job of retry) job.attempts++;
				this.recycle(guest, "no response before the guest timeout");
				this.queue.unshift(...retry);
				for (const job of taken) {
					if (!retry.includes(job) && !job.done) {
						job.error = new Error("guest did not return response headers");
						this.finish(job);
					}
				}
				if (self.signal.aborted) {
					self.error = new Error("client disconnected");
						this.finish(self);
				}
				return;
			}

			for (let index = 0; index < taken.length; index++) {
				const job = taken[index];
				const result = settled[index];
				if (result.status === "rejected") {
					job.error = result.reason;
						this.finish(job);
					continue;
				}
				if (!job.done) {
					job.reply = result.value;
				job.queueMs = startedAt - job.queuedAt;
				job.batch = taken.length;
					this.finish(job);
				}
			}
		} finally {
			this.release(self);
		}
	}

	private owns(job: Job): boolean {
		return this.owner === job && !job.done && !job.signal.aborted;
	}

	private release(job: Job): void {
		if (this.owner !== job) return;
		this.owner = undefined;
		this.active = [];
	}

	private async run(job: Job, guest: Guest, startedAt: number): Promise<GuestResult> {
		if (job.cpuGeneration !== undefined) return this.runCpu(job, guest, startedAt);
		const { response, dispose } = await this.fetchHeaders(job, guest);
		return this.bufferResponse(job, response, dispose, startedAt);
	}

	private async runCpu(job: Job, guest: Guest, startedAt: number): Promise<GuestResult> {
		let resolveCancel!: () => void;
		const cancelled = new Promise<void>((resolve) => (resolveCancel = resolve));
		job.onCancel = resolveCancel;
		if (job.cancelRequested) resolveCancel();
		const timer = setTimeout(() => {
			this.requestCancellation(job, new DOMException("CPU shard timed out", "TimeoutError"));
		}, job.timeoutMs ?? CPU_TIMEOUT_MS);
		const fetchController = new AbortController();
		const cpuFetch = guest.vm.fetch(job.url, {
			method: job.method,
			headers: job.headers,
			body: job.body,
			signal: AbortSignal.any([job.signal, fetchController.signal]),
		});
		const finishCancellation = async (): Promise<void> => {
			const stopFetch = () => {
				fetchController.abort(job.cancelReason);
				job.cancelController?.abort(job.cancelReason);
				let timer: ReturnType<typeof setTimeout>;
				const timeout = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("CPU fetch did not stop")), 1000);
				});
				return Promise.race([cpuFetch.catch(() => {}), timeout]).finally(() => clearTimeout(timer!));
			};
			try {
				await this.cancelGuestCpu(job, guest);
				await stopFetch();
			} catch (cause) {
				await stopFetch().catch(() => {});
				job.error = new Error("guest CPU cancellation failed", { cause });
				this.finish(job);
				throw new GuestError("guest CPU cancellation failed", "headers", false, { cause }, true);
			}
		};
		try {
			const outcome = await Promise.race([
				cpuFetch.then((response) => ({ kind: "response" as const, response })),
				cancelled.then(() => ({ kind: "cancelled" as const })),
			]);
			if (outcome.kind === "cancelled") {
				await finishCancellation();
				this.finish(job);
				throw job.cancelReason ?? new DOMException("CPU shard cancelled", "AbortError");
			}
			if (job.cancelRequested) {
				await finishCancellation();
				this.finish(job);
				throw job.cancelReason ?? new DOMException("CPU shard cancelled", "AbortError");
			}
			clearTimeout(timer);
			return await this.bufferResponse(job, outcome.response, () => {}, startedAt);
		} catch (cause) {
			if (cause instanceof GuestError) throw cause;
			if (job.cancelRequested) {
				await finishCancellation();
				this.finish(job);
				throw job.cancelReason ?? cause;
			}
			throw new GuestError("guest failed before returning response headers", "headers", job.signal.aborted, { cause });
		} finally {
			clearTimeout(timer);
			job.onCancel = undefined;
		}
	}

	private async bufferResponse(
		job: Job,
		response: Response,
		dispose: () => void,
		startedAt: number,
	): Promise<GuestResult> {
		const ttfbMs = Date.now() - startedAt;
		const headers = new Headers(response.headers);
		let bytes: Uint8Array<ArrayBuffer> | null = null;
		let bodyMs = 0;
		if (job.method !== "HEAD" && response.body !== null) {
			try {
				bytes = await readCapped(
					response.body,
					job.batchable ? MAX_BATCH_BYTES : MAX_EXCLUSIVE_RESPONSE_BYTES,
				);
				bodyMs = Date.now() - startedAt - ttfbMs;
			} catch (cause) {
				await response.body.cancel(cause).catch(() => {});
				throw new GuestError("guest response body failed", "body", job.signal.aborted, { cause });
			} finally {
				dispose();
			}
		} else {
			dispose();
		}
		return {
			status: response.status,
			statusText: response.statusText,
			headers: [...headers],
			body: bytes && bytes.byteLength ? bytes : null,
			ttfbMs,
			bodyMs,
		};
	}

	/** Bound only the wait for response headers; body reads retain client cancellation. */
	private async fetchHeaders(job: Job, guest: Guest): Promise<{ response: Response; dispose: () => void }> {
		const controller = new AbortController();
		const onAbort = () => controller.abort(job.signal.reason);
		job.signal.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const cause = new DOMException("guest response headers timed out", "TimeoutError");
				controller.abort(cause);
				reject(cause);
			}, job.timeoutMs ?? GUEST_TIMEOUT_MS);
		});
		try {
			const response = await Promise.race([
				guest.vm.fetch(job.url, {
					method: job.method,
					headers: job.headers,
					body: job.body,
					signal: controller.signal,
				}),
				timeout,
			]);
			return {
				response,
				dispose: () => job.signal.removeEventListener("abort", onAbort),
			};
		} catch (cause) {
			job.signal.removeEventListener("abort", onAbort);
			if (job.signal.aborted) {
				throw new GuestError("client disconnected", "headers", true, { cause });
			}
			throw new GuestError(
				cause instanceof DOMException && cause.name === "TimeoutError"
					? "guest response headers timed out"
					: "guest failed before returning response headers",
				"headers",
				false,
				{ cause },
			);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	private respond(job: Job): Response {
		if (!job.reply || job.error) return error(502, job.error ?? new Error("empty response"));
		const headers = new Headers(job.reply.headers);
		headers.set("server-timing", "unkernel-queue;dur=" + (job.queueMs ?? 0) + ";desc=\"waiting for a turn\"");
		return new Response(job.reply.body, {
			status: job.reply.status,
			statusText: job.reply.statusText,
			headers,
		});
	}

	private ensureBoot(ctx: ExecutionContextLike): Promise<Guest> {
		if (this.guest) return Promise.resolve(this.guest);
		if (!this.bootPromise) {
			const promise = boot().then((guest) => {
				this.guest = guest;
				return guest;
			});
			this.bootPromise = promise;
			ctx.waitUntil(promise.then(() => {}, () => {}));
			promise.catch(() => {
				if (this.bootPromise === promise) this.bootPromise = undefined;
			});
		}
		return this.bootPromise;
	}

	private recycle(guest: Guest, why: string): void {
		if (this.guest !== guest) return;
		this.guest = undefined;
		this.bootPromise = undefined;
		console.error("[unkernel shard] recycling the guest VM: " + why);
		void guest.vm.stop().catch(() => {});
	}

	debug(): Record<string, unknown> {
		return {
			guest: this.guest?.vm.debug() ?? null,
			queue: this.queue.map((job) => ({ id: job.id, method: job.method, ageMs: Date.now() - job.queuedAt })),
			active: this.active.map((job) => job.id),
			turns: this.stats,
		};
	}
}

/** A named Durable Object is one independently scheduled kernel shard. */
export class UnkernelGuest extends DurableObject {
	#manager = new GuestManager();

	async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/__debug") {
			return Response.json(this.#manager.debug(), { headers: { "cache-control": "no-store" } });
		}
		return this.#manager.handle(request, this.ctx);
	}

	cpu(jobs: number, iterations: number, offset: number, token: string): Promise<CpuResult> {
		return this.#manager.cpu(jobs, iterations, offset, token, this.ctx);
	}

	cancel(token: string): Promise<void> {
		return this.#manager.cancel(token);
	}

	debug(): Record<string, unknown> {
		return this.#manager.debug();
	}

	prewarm(): Promise<void> {
		return this.#manager.prewarm(this.ctx);
	}
}

interface Env {
	UNKERNEL: DurableObjectNamespace<UnkernelGuest>;
}

let nextShard = 0;
let nextRequestShard = 0;
let prewarmStarted = false;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/cpu") return cpuFanout(request, env, ctx);
		if (url.pathname === "/cpu/cancel") return new Response("not found\n", { status: 404 });
		if (url.pathname === "/__debug") {
			const shards = await Promise.all(
				Array.from({ length: SHARD_COUNT }, (_, index) =>
					env.UNKERNEL.getByName(String(index)).debug(),
				),
			);
			return new Response(JSON.stringify(shards), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
		}
		if (request.headers.get("x-unkernel-prewarm") === "1" && !prewarmStarted) {
			prewarmStarted = true;
			ctx.waitUntil(Promise.allSettled(
				[1, 2, 3].map((shard) => env.UNKERNEL.getByName(String(shard)).prewarm()),
			).then(() => (prewarmStarted = false)));
		}
		// The demo guest is stateless. Keep an explicit shard0 escape hatch for
		// any future route that needs affinity while defaulting to round-robin.
		const shard = request.headers.get("x-unkernel-route") === "shard0"
			? 0
			: nextRequestShard++ % SHARD_COUNT;
		return env.UNKERNEL.getByName(String(shard)).fetch(request);
	},
};

/** Split independent CPU jobs across kernels and reduce their checksums. */
async function cpuFanout(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
	const url = new URL(request.url);
	let jobs = 4;
	let iterations = 8_000_000;
	let shards = SHARD_COUNT;
	for (const pair of url.searchParams.entries()) {
		if (pair[0] === "jobs") jobs = Number(pair[1]);
		if (pair[0] === "iterations") iterations = Number(pair[1]);
		if (pair[0] === "shards") shards = Number(pair[1]);
	}
	if (!Number.isSafeInteger(jobs) || jobs < 1) jobs = 4;
	if (!Number.isSafeInteger(iterations) || iterations < 1) iterations = 8_000_000;
	if (!Number.isSafeInteger(shards) || shards < 1) shards = SHARD_COUNT;
	jobs = Math.min(jobs, 16);
	iterations = Math.min(iterations, 50_000_000);
	shards = Math.min(shards, SHARD_COUNT);

	const started = Date.now();
	const shardCount = Math.min(shards, jobs);
	const firstShard = nextShard;
	nextShard = (nextShard + 1) % SHARD_COUNT;
	const base = Math.floor(jobs / shardCount);
	const extra = jobs % shardCount;
	const token = crypto.randomUUID();
	const calls: Array<{ stub: DurableObjectRpcStub<UnkernelGuest>; token: string; jobs: number; offset: number }> = [];
	let offset = 0;
	for (let index = 0; index < shardCount; index++) {
		const count = base + (index < extra ? 1 : 0);
		const shard = (firstShard + index) % SHARD_COUNT;
		calls.push({ stub: env.UNKERNEL.getByName(String(shard)), token, jobs: count, offset });
		offset += count;
	}

	let failed = false;
	const requests = calls.map((call) => call.stub.cpu(call.jobs, iterations, call.offset, call.token).catch((cause) => {
		if (!failed) {
			failed = true;
			cancelAll();
		}
		throw cause;
	}));
	// AbortSignal is not an RPC argument. A private token plus an explicit
	// cancel RPC gives cancellation without exposing a bearer capability.
	const cancellation = new AbortController();
	const cancelAll = () => {
		if (cancellation.signal.aborted) return;
		cancellation.abort();
		const cancels = calls.map((call) => call.stub.cancel(call.token).catch(() => {}));
		// Keep both the original CPU calls and their cancellations alive after
		// the client disconnects. The DO drivers remain the only VM drivers.
		ctx.waitUntil(Promise.allSettled([...requests, ...cancels]));
	};
	let onAbort!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => {
			cancelAll();
			reject(request.signal.reason ?? new DOMException("CPU request aborted", "AbortError"));
		};
		request.signal.addEventListener("abort", onAbort, { once: true });
		if (request.signal.aborted) onAbort();
	});
	let results: CpuResult[];
	try {
		results = await Promise.race([Promise.all(requests), aborted]);
	} catch (cause) {
		if (request.signal.aborted) {
			return new Response("cancelled\n", { status: 499, headers: { "cache-control": "no-store" } });
		}
		return error(502, cause);
	} finally {
		request.signal.removeEventListener("abort", onAbort);
	}
	const checksum = results.reduce((sum, result) => sum + BigInt(result.checksum), 0n) & ((1n << 64n) - 1n);
	return Response.json({
		jobs,
		iterations,
		parallelism: shardCount,
		guestParallelism: Math.min(...results.map((result) => result.parallelism)),
		guestSamples: results.map((result) => ({ parallelism: result.parallelism })),
		elapsedMs: Date.now() - started,
		checksum: checksum.toString(),
	}, { headers: { "cache-control": "no-store" } });
}

class RequestTooLargeError extends Error {}

async function readRequestBody(request: Request): Promise<ArrayBuffer | undefined> {
	if (!request.body) return undefined;
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
		await request.body.cancel().catch(() => {});
		throw new RequestTooLargeError("request body exceeds the 8 MiB shard limit");
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_REQUEST_BYTES) {
			await reader.cancel().catch(() => {});
			throw new RequestTooLargeError("request body exceeds the 8 MiB shard limit");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes.buffer;
}

function isBatchable(method: string, body: ArrayBuffer | undefined): boolean {
	return (method === "GET" || method === "HEAD" || method === "OPTIONS") && (!body || body.byteLength === 0);
}

function pollDelay(polls: number): number {
	return Math.min(1 + (polls >> 2), 4);
}

async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array<ArrayBuffer>> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel().catch(() => {});
			throw new Error("response exceeded the " + cap + "-byte shard buffer");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function boot(): Promise<Guest> {
	const started = Date.now();
	let vm: KernelInstance | undefined;
	try {
		vm = await createKernel({ jit: false });
		const decoder = new TextDecoder();
		vm.onOutput((bytes) => {
			const text = decoder.decode(bytes);
			if (text) console.log("[guest] " + text.trimEnd());
		});
		const server = await vm.spawn(GUEST_FILE, [], { pty: false });
		void drain(server.stdout, "out");
		void drain(server.stderr, "err");
		await waitForServer(vm);
		console.log("[unkernel shard] booted in " + (Date.now() - started) + " ms");
		return { vm };
	} catch (error) {
		if (vm) void vm.stop().catch(() => {});
		throw error;
	}
}

async function waitForServer(vm: KernelInstance): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	let delay = 2;
	let lastError: unknown;
	for (;;) {
		try {
			const socket = await vm.connect(GUEST_PORT);
			await socket.close();
			return;
		} catch (error) {
			lastError = error;
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
			delay = Math.min(delay * 2, 100);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function drain(stream: ReadableStream<Uint8Array>, name: string): Promise<void> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffered = "";
	let logged = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		buffered += decoder.decode(value, { stream: true });
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line && logged < 16) {
				logged++;
				console.log("[axum-hello:" + name + "] " + line);
			}
		}
	}
}

function error(status: number, cause: unknown): Response {
	const message = cause instanceof Error ? cause.message : String(cause);
	console.error("[unkernel shard] " + message);
	return new Response("unkernel shard: " + message + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

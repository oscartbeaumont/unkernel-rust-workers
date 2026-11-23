// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Console output fan-out shared by KernelInstance (instance.ts) and
// WorkerKernel (worker-host.ts): listeners, and one ReadableStream that
// starts with a backlog of everything since boot.

/** Console output kept for the `output` stream until it is first read. */
const OUTPUT_BACKLOG = 1 << 20;

export class ConsoleOutput {
	#listeners = new Set<(bytes: Uint8Array) => void>();
	/** Chunks from #backlogHead on are kept (dropping from the front by index: Array.shift() of a long array copies it). */
	#backlog: Uint8Array[] | null = [];
	#backlogHead = 0;
	#backlogBytes = 0;
	#stream: ReadableStream<Uint8Array> | undefined;
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	#closed = false;
	#ended: () => boolean;

	/** `ended` tells whether the kernel has exited before close() runs. */
	constructor(ended: () => boolean = () => false) {
		this.#ended = ended;
	}

	/** Console output from the kernel. */
	emit(bytes: Uint8Array): void {
		for (const l of this.#listeners) l(bytes);
		if (this.#controller) {
			this.#controller.enqueue(bytes);
		} else if (this.#backlog) {
			const b = this.#backlog;
			b.push(bytes);
			this.#backlogBytes += bytes.length;
			while (this.#backlogBytes > OUTPUT_BACKLOG && b.length - this.#backlogHead > 1) {
				this.#backlogBytes -= b[this.#backlogHead]!.length;
				b[this.#backlogHead++] = undefined!;
			}
			if (this.#backlogHead > 1024 && this.#backlogHead * 2 > b.length) {
				b.splice(0, this.#backlogHead);
				this.#backlogHead = 0;
			}
		}
	}

	/** The kernel exited: close the stream and drop a backlog nobody read. */
	close(): void {
		this.#closed = true;
		try { this.#controller?.close(); } catch {}
		this.#backlog = null;
	}

	/** The one output stream: the backlog first, then everything as it comes; closed once the kernel exits. */
	get stream(): ReadableStream<Uint8Array> {
		if (!this.#stream) {
			const backlog = this.#backlog?.slice(this.#backlogHead) ?? [];
			this.#backlog = null;
			this.#stream = new ReadableStream<Uint8Array>({
				start: (c) => {
					for (const b of backlog) c.enqueue(b);
					if (this.#closed || this.#ended()) c.close();
					else this.#controller = c;
				},
			});
		}
		return this.#stream;
	}

	listen(listener: (bytes: Uint8Array) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

/**
 * An error as log text: its stack, led by its name and message where the
 * engine's stack leaves them out (Firefox and Safari give the frames alone,
 * so "CPU 1: <frame>" said nothing of what failed).
 */
export function errorText(e: unknown): string {
	const err = e as { name?: unknown; message?: unknown; stack?: unknown } | null | undefined;
	if (err === null || typeof err !== "object") return String(e);
	const head = `${typeof err.name === "string" && err.name ? err.name : "Error"}: ${typeof err.message === "string" ? err.message : ""}`;
	const stack = typeof err.stack === "string" ? err.stack : "";
	if (!stack) return head;
	return typeof err.message === "string" && err.message && stack.includes(err.message) ? stack : `${head}\n${stack}`;
}

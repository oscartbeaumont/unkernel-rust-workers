// SPDX-License-Identifier: MIT
// The JSPI API (WebAssembly.Suspending / WebAssembly.promising), which this
// tsconfig's lib (ESNext + WebWorker) does not declare yet. Same shapes as
// the SDK uses in js/core.

declare namespace WebAssembly {
	/** Mark an imported function as one that may suspend its caller's wasm stack. */
	class Suspending {
		constructor(fn: (...args: never[]) => unknown);
	}
	/** Wrap an exported function so that its suspension is a promise to the caller. */
	function promising<T extends (...args: never[]) => unknown>(fn: T): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
}

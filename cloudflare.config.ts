import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "unkernel-rust-workers",
		compatibilityDate: "2026-11-17",
		// A kernel booted in one request is driven by later requests. The turn
		// queues never await a promise another request resolves, but the VM's
		// own JSPI continuations still cross that boundary.
		compatibilityFlags: ["no_handle_cross_request_promise_resolution"],
		entrypoint: "worker/do.ts",
		exports: {
			UnkernelGuest: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			UNKERNEL: bindings.durableObject({
				worker: "unkernel-rust-workers",
				exportName: "UnkernelGuest",
			}),
		},
	},
});

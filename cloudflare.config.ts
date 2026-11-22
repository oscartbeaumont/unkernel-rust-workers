import { defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "unkernel-rs",
		compatibilityDate: "2026-11-17",
		compatibilityFlags: [
			"no_handle_cross_request_promise_resolution",
		],
		entrypoint: "worker/index.ts",
	},
});

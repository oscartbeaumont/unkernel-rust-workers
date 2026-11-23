import { defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "unkernel-rs",
		compatibilityDate: "2026-11-17",
		// The kernel boots in the first request that runs it and then lives in
		// the isolate: its promise chains (JSPI continuations) settle in later
		// requests. The default handling would drop them once the boot request
		// ends, so this VM needs the legacy cross-request behavior. Requests
		// never wait on a promise another request resolves (worker/index.ts's
		// batched turns plus timer polling), so the legacy behavior is safe here.
		compatibilityFlags: [
			"no_handle_cross_request_promise_resolution",
		],
		entrypoint: "worker/index.ts",
	},
});

import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	rules: [
		{
			type: "Data",
			globs: [
				"assets/*.bin",
			],
			fallthrough: true,
		},
	],
});

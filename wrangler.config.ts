import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	// Ship less: the bundle is minified, and a source map of it is not worth
	// its own upload.
	minify: true,
	uploadSourceMaps: false,
});

// The wrangler-bundled modules the Worker imports (see wrangler.toml).
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.bin" {
  const data: ArrayBuffer | Uint8Array;
  export default data;
}

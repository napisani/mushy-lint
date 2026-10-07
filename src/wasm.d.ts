// Bun resolves `with { type: "file" }` imports to a path, embedded in compiled binaries.
declare module "*.wasm" {
  const path: string;
  export default path;
}

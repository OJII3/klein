import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

interface BunBuildOptions {
  readonly entrypoints: readonly string[];
  readonly target: "bun";
  readonly outdir: string;
  readonly naming: string;
  readonly minify: boolean;
  readonly define: Readonly<Record<string, string>>;
  readonly external: readonly string[];
  readonly throw: boolean;
}

declare const Bun: {
  build(options: BunBuildOptions): Promise<unknown>;
};

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repoRoot = resolve(packageRoot, "../..");
const outdir = resolve(repoRoot, "dist");

await mkdir(outdir, { recursive: true });

await Bun.build({
  entrypoints: [resolve(packageRoot, "src/app/bootstrap.ts")],
  target: "bun",
  outdir,
  naming: "klein",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  external: ["@earendil-works/pi-codemode", "@snazzah/davey", "ffmpeg-static"],
  throw: true,
});

// The bundled ONNX Runtime Web code loads its WASM runtime next to the bundle.
const require = createRequire(import.meta.url);
const onnxRuntimeDist = resolve(dirname(require.resolve("onnxruntime-web/package.json")), "dist");
for (const asset of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  await copyFile(resolve(onnxRuntimeDist, asset), resolve(outdir, asset));
}

import { copyFile } from "node:fs/promises";

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

await Bun.build({
  entrypoints: ["src/app/bootstrap.ts"],
  target: "bun",
  outdir: "dist",
  naming: "klein",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  external: ["@earendil-works/pi-codemode", "@snazzah/davey", "ffmpeg-static"],
  throw: true,
});

// The bundled ONNX Runtime Web code loads its WASM runtime next to the bundle.
for (const asset of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  await copyFile(`node_modules/onnxruntime-web/dist/${asset}`, `dist/${asset}`);
}

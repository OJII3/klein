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
  await Bun.write(`dist/${asset}`, Bun.file(`node_modules/onnxruntime-web/dist/${asset}`));
}

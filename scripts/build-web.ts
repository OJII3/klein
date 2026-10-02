await Bun.build({
  entrypoints: ["web/index.html"],
  target: "browser",
  outdir: "dist/web",
  minify: true,
  throw: true,
});

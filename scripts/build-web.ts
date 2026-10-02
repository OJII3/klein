await Bun.build({
  entrypoints: ["web/index.html"],
  target: "browser",
  outdir: "dist/web",
  publicPath: "/",
  minify: true,
  throw: true,
});

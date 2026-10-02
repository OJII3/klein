await Bun.build({
  entrypoints: ["src/app/bootstrap.ts"],
  target: "bun",
  outdir: "dist",
  naming: "klein",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  external: ["@discordjs/voice", "opusscript", "@earendil-works/pi-codemode"],
  throw: true,
});

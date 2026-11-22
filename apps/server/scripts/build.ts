import { copyFile, cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface BunPluginBuild {
  onResolve(
    options: { readonly filter: RegExp; readonly namespace?: string },
    callback: (args: { readonly path: string }) => {
      readonly path: string;
      readonly namespace?: string;
    } | void,
  ): void;
  onLoad(
    options: { readonly filter: RegExp; readonly namespace?: string },
    callback: (args: {
      readonly path: string;
    }) =>
      | { readonly contents: string; readonly loader: "js" | "ts" }
      | Promise<{ readonly contents: string; readonly loader: "js" | "ts" }>,
  ): void;
}

interface BunPlugin {
  readonly name: string;
  setup(build: BunPluginBuild): void;
}

interface BunBuildOptions {
  readonly entrypoints: readonly string[];
  readonly target: "bun";
  readonly outdir: string;
  readonly naming: string;
  readonly minify: boolean;
  readonly define?: Readonly<Record<string, string>>;
  readonly external?: readonly string[];
  readonly plugins?: readonly BunPlugin[];
  readonly throw: boolean;
}

declare const Bun: {
  build(options: BunBuildOptions): Promise<unknown>;
};

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repoRoot = resolve(packageRoot, "../..");
const outdir = resolve(repoRoot, "dist");
const require = createRequire(import.meta.url);

const piPackageDir = dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
const piInternalsPath = resolve(packageRoot, "src/runtime/pi/pi-internals.ts");
const daveyEntryPath = require.resolve("@snazzah/davey");
const opusScriptWasmJsPath = resolve(
  dirname(require.resolve("opusscript/package.json")),
  "build/opusscript_native_wasm.js",
);
const photonJsPath = resolve(
  dirname(require.resolve("@silvia-odwyer/photon-node/package.json")),
  "photon_rs.js",
);

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function replaceOnce(
  source: string,
  search: string,
  replacement: string,
  fileLabel: string,
): string {
  if (!source.includes(search)) {
    throw new Error(`Expected snippet not found in ${fileLabel}: ${search}`);
  }
  return source.replace(search, replacement);
}

await mkdir(outdir, { recursive: true });
for (const entry of await readdir(outdir)) {
  if (entry === "web") continue;
  await rm(resolve(outdir, entry), { force: true, recursive: true });
}

const bundlePortabilityPlugin: BunPlugin = {
  name: "klein-bundle-portability",
  setup(build) {
    // Statically re-export Pi internals so Bun.build bundles them without node_modules paths.
    build.onLoad({ filter: new RegExp(`^${escapeRegex(piInternalsPath)}$`) }, () => {
      const mcpConfigPath = JSON.stringify(resolve(piPackageDir, "dist/extensions/mcp/config.js"));
      const mcpCliPath = JSON.stringify(resolve(piPackageDir, "dist/extensions/mcp/cli.js"));
      const piConfigPath = JSON.stringify(resolve(piPackageDir, "dist/config.js"));
      return {
        contents: [
          `export { loadMcpConfig } from ${mcpConfigPath};`,
          `export { runMcpCommand as runPiMcpCommand } from ${mcpCliPath};`,
          `export { setEmbeddedQuickJSWasmPath } from ${piConfigPath};`,
        ].join("\n"),
        loader: "ts",
      };
    });

    // Keep @snazzah/davey's native .node lookup anchored to the bundle directory.
    build.onLoad({ filter: new RegExp(`^${escapeRegex(daveyEntryPath)}$`) }, async (args) => {
      const contents = replaceOnce(
        await readFile(args.path, "utf8"),
        "require = createRequire(__filename)",
        "require = createRequire(import.meta.url)",
        args.path,
      );
      return { contents, loader: "js" };
    });

    // prism-media probes optional ffmpeg-static inside try/catch; fail cleanly without npm install.
    build.onResolve({ filter: /^ffmpeg-static$/ }, () => ({
      path: "ffmpeg-static",
      namespace: "klein-missing-optional",
    }));
    build.onLoad({ filter: /^ffmpeg-static$/, namespace: "klein-missing-optional" }, () => ({
      contents:
        'throw Object.assign(new Error("Cannot find module \'ffmpeg-static\'"), { code: "MODULE_NOT_FOUND" });',
      loader: "js",
    }));

    // Resolve opusscript WASM next to the bundle instead of the build machine's node_modules.
    build.onLoad({ filter: new RegExp(`^${escapeRegex(opusScriptWasmJsPath)}$`) }, async (args) => {
      const contents = replaceOnce(
        await readFile(args.path, "utf8"),
        'p=ea?ia.dirname(p)+"/":__dirname+"/"',
        'p=ea?ia.dirname(p)+"/":ia.dirname(require("url").fileURLToPath(import.meta.url))+"/"',
        args.path,
      );
      return { contents, loader: "js" };
    });

    // Resolve photon WASM next to the bundle instead of the build machine's node_modules.
    build.onLoad({ filter: new RegExp(`^${escapeRegex(photonJsPath)}$`) }, async (args) => {
      const contents = replaceOnce(
        await readFile(args.path, "utf8"),
        "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');",
        "const path = require('path').join(require('path').dirname(require('url').fileURLToPath(import.meta.url)), 'photon_rs_bg.wasm');",
        args.path,
      );
      return { contents, loader: "js" };
    });
  },
};

await Bun.build({
  entrypoints: [resolve(packageRoot, "src/app/bootstrap.ts")],
  target: "bun",
  outdir,
  naming: "klein",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [bundlePortabilityPlugin],
  throw: true,
});

// Build the QuickJS codemode worker alongside dist/klein so defaultWorkerUrl() resolves ./worker.js.
const codemodeWorkerEntry = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-codemode/worker"),
);
await Bun.build({
  entrypoints: [codemodeWorkerEntry],
  target: "bun",
  outdir,
  naming: "worker.js",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  throw: true,
});

const onnxRuntimeDist = resolve(dirname(require.resolve("onnxruntime-web/package.json")), "dist");
for (const asset of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  await copyFile(resolve(onnxRuntimeDist, asset), resolve(outdir, asset));
}

await copyFile(
  resolve(dirname(opusScriptWasmJsPath), "opusscript_native_wasm.wasm"),
  resolve(outdir, "opusscript_native_wasm.wasm"),
);

await copyFile(
  resolve(dirname(photonJsPath), "photon_rs_bg.wasm"),
  resolve(outdir, "photon_rs_bg.wasm"),
);

const bundledPiPackageDir = resolve(outdir, "pi-package");
await mkdir(bundledPiPackageDir, { recursive: true });
await copyFile(resolve(piPackageDir, "package.json"), resolve(bundledPiPackageDir, "package.json"));
await cp(resolve(piPackageDir, "docs"), resolve(bundledPiPackageDir, "docs"), { recursive: true });

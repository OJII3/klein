import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The bundled build runs from dist/, where pi cannot find its own package.json and
// falls back to an unrelated package version. pi.dev rejects unknown versions with
// 404, so point pi at the bundled metadata directory (or installed package in dev).
export function configurePiPackageDir(): void {
  if (process.env.PI_PACKAGE_DIR) return;
  const bundledPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), "pi-package");
  if (existsSync(resolve(bundledPackageDir, "package.json"))) {
    process.env.PI_PACKAGE_DIR = bundledPackageDir;
    return;
  }
  try {
    const require = createRequire(import.meta.url);
    process.env.PI_PACKAGE_DIR = dirname(
      require.resolve("@earendil-works/pi-coding-agent/package.json"),
    );
  } catch {
    // Leave pi's own resolution in place when the package metadata is unavailable.
  }
}

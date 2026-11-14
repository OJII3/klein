import { createRequire } from "node:module";
import { dirname } from "node:path";

// The bundled build runs from dist/, where pi cannot find its own package.json and
// falls back to an unrelated package version. pi.dev rejects unknown versions with
// 404, so point pi at the installed package before it reads its version.
if (!process.env.PI_PACKAGE_DIR) {
  try {
    const require = createRequire(import.meta.url);
    process.env.PI_PACKAGE_DIR = dirname(
      require.resolve("@earendil-works/pi-coding-agent/package.json"),
    );
  } catch {
    // Leave pi's own resolution in place when the package metadata is unavailable.
  }
}

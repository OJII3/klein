import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import quickjsWasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };

export function resolveQuickJsWasmPath(): string {
  return isAbsolute(quickjsWasmPath)
    ? quickjsWasmPath
    : resolve(dirname(fileURLToPath(import.meta.url)), quickjsWasmPath);
}

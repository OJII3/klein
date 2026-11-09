import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDir extends AsyncDisposable {
  readonly path: string;
}

export async function createTempDir(prefix: string): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async [Symbol.asyncDispose]() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

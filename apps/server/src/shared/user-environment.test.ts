import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../testing/temp-dir";
import {
  ensureUserEnvironment,
  resolveUserEnvironment,
  userEnvironmentKey,
  userEnvironmentVariables,
} from "./user-environment";

test("keeps each linked user inside their own directory", () => {
  const environment = resolveUserEnvironment("/tmp/agent", "123");

  assert.equal(environment.rootDirectory, "/tmp/agent/users/123");
  assert.equal(environment.workspaceDirectory, "/tmp/agent/users/123/workspace");
  assert.equal(environment.homeDirectory, "/tmp/agent/users/123/home");
  assert.equal(environment.credentialsDirectory, "/tmp/agent/users/123/credentials");
  assert.equal(environment.temporaryDirectory, "/tmp/agent/users/123/tmp");
});

test("sanitizes user ids for directory names", () => {
  assert.equal(userEnvironmentKey("123"), "123");
  assert.equal(userEnvironmentKey("user/../456"), "user____456");
});

test("creates the environment with owner-only permissions", async () => {
  await using temp = await createTempDir("klein-user-environment-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));

  for (const directory of [
    environment.rootDirectory,
    environment.workspaceDirectory,
    environment.homeDirectory,
    environment.credentialsDirectory,
    environment.temporaryDirectory,
  ]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
  }
  assert.equal(statSync(join(temp.path, "users")).mode & 0o777, 0o700);
});

test("points tools at the user's home and temporary directories", () => {
  const environment = resolveUserEnvironment("/tmp/agent", "123");

  assert.deepEqual(userEnvironmentVariables(environment), {
    HOME: "/tmp/agent/users/123/home",
    XDG_CONFIG_HOME: "/tmp/agent/users/123/home/.config",
    XDG_CACHE_HOME: "/tmp/agent/users/123/home/.cache",
    XDG_DATA_HOME: "/tmp/agent/users/123/home/.local/share",
    XDG_STATE_HOME: "/tmp/agent/users/123/home/.local/state",
    TMPDIR: "/tmp/agent/users/123/tmp",
  });
});

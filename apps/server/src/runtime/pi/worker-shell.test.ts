import assert from "node:assert/strict";
import { delimiter, resolve } from "node:path";
import test from "node:test";

import { ensureUserEnvironment, resolveUserEnvironment } from "@shared/user-environment";
import { createTempDir } from "../../testing/temp-dir";
import { hostShellEnvironment, resolveWorkerShell, runHostCommand } from "./worker-shell";

test("gives owner workers a host shell and other linked workers a sandbox", async () => {
  await using temp = await createTempDir("klein-worker-shell-");
  const environment = ensureUserEnvironment(resolveUserEnvironment(temp.path, "123"));
  const homeDirectory = "/home/klein";

  const ownerShell = resolveWorkerShell({
    role: { kind: "worker", workerId: "owner-worker" },
    ownerFeaturesAllowed: true,
    environment,
    homeDirectory,
  });
  assert.deepEqual(ownerShell, { kind: "host", homeDirectory });

  const sandboxShell = resolveWorkerShell({
    role: { kind: "worker", workerId: "linked-worker" },
    ownerFeaturesAllowed: false,
    environment,
    homeDirectory,
  });
  assert.deepEqual(sandboxShell, { kind: "sandbox", environment });

  for (const role of [{ kind: "conversation" }, { kind: "standalone" }] as const) {
    assert.equal(
      resolveWorkerShell({ role, ownerFeaturesAllowed: true, environment, homeDirectory }),
      undefined,
    );
  }
  assert.equal(
    resolveWorkerShell({
      role: { kind: "worker", workerId: "public-worker" },
      ownerFeaturesAllowed: true,
      environment: undefined,
      homeDirectory,
    }),
    undefined,
  );
});

test("builds a host shell environment from an allowlist", () => {
  const environment = hostShellEnvironment(
    {
      HOME: "/home/other",
      PATH: "/usr/bin:/bin:",
      LANG: "ja_JP.UTF-8",
      TMPDIR: "/var/tmp/owner",
      PI_SESSION_ID: "session-1",
      PI_CODING_AGENT_DIR: "/srv/klein",
      DISCORD_BOT_TOKEN: "discord-token",
      OPENCODE_API_KEY: "opencode-key",
      TUNNEL_TOKEN: "tunnel-token",
      USAGE_TOKEN: "usage-token",
      CONFIG_PATH: "/srv/klein/config.json",
    },
    "/home/klein",
  );

  assert.equal(environment.HOME, "/home/klein");
  assert.equal(environment.LANG, "ja_JP.UTF-8");
  assert.equal(environment.TERM, "dumb");
  assert.equal(environment.TMPDIR, "/var/tmp/owner");
  assert.equal(environment.PI_SESSION_ID, "session-1");
  assert.equal(environment.PATH?.split(delimiter)[0], resolve("/home/klein", ".local", "bin"));
  assert.ok(!environment.PATH?.split(delimiter).includes(""));
  for (const name of [
    "DISCORD_BOT_TOKEN",
    "OPENCODE_API_KEY",
    "TUNNEL_TOKEN",
    "USAGE_TOKEN",
    "CONFIG_PATH",
    "PI_CODING_AGENT_DIR",
  ]) {
    assert.equal(environment[name], undefined);
  }
});

test("runs host commands in the home with only allowed variables", async () => {
  await using temp = await createTempDir("klein-host-shell-");
  const previousToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "host-token";
  try {
    const result = await runHostCommand(
      temp.path,
      [
        "pwd",
        'printf "HOME=%s\\n" "$HOME"',
        'printf "SECRET=%s\\n" "$KLEIN_SECRET_TEST_TOKEN"',
        'printf "DISCORD=%s\\n" "${DISCORD_BOT_TOKEN-missing}"',
      ].join("\n"),
      { secretEnvironment: { KLEIN_SECRET_TEST_TOKEN: "secret-value" } },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
    const lines = result.output.split("\n");
    assert.equal(lines[0], temp.path);
    assert.ok(lines.includes(`HOME=${temp.path}`));
    assert.ok(lines.includes("SECRET=secret-value"));
    assert.ok(lines.includes("DISCORD=missing"));
  } finally {
    if (previousToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previousToken;
  }
});

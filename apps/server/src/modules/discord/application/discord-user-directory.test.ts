import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import { DiscordUserDirectory } from "./discord-user-directory";

const alice = {
  bot: false,
  displayName: "Alice",
  id: "123456789012345678",
  username: "alice",
} as const;

const bob = {
  bot: false,
  displayName: "Bob",
  id: "223456789012345678",
  username: "bob",
} as const;

test("remembers users and resolves usernames case-insensitively", async () => {
  await using temp = await createTempDir("klein-discord-users-");
  const directory = new DiscordUserDirectory(join(temp.path, "discord-users.json"));

  directory.remember(alice);
  directory.remember(bob);

  assert.equal(directory.resolve("alice")?.id, alice.id);
  assert.equal(directory.resolve("@Alice")?.id, alice.id);
  assert.equal(directory.resolve("ALICE")?.id, alice.id);
  assert.equal(directory.resolve("bob")?.id, bob.id);
  assert.equal(directory.resolve("unknown"), undefined);
  assert.deepEqual(
    directory.list().map((user) => user.username),
    ["alice", "bob"],
  );
});

test("persists users across directory instances", async () => {
  await using temp = await createTempDir("klein-discord-users-");
  const filePath = join(temp.path, "discord-users.json");

  const first = new DiscordUserDirectory(filePath);
  first.remember(alice);
  first.remember(bob);
  await first.flush();

  const second = new DiscordUserDirectory(filePath);
  await second.load();

  assert.equal(second.resolve("alice")?.id, alice.id);
  assert.equal(second.resolve("bob")?.displayName, bob.displayName);
});

test("keeps the numeric ID when a username changes", async () => {
  await using temp = await createTempDir("klein-discord-users-");
  const filePath = join(temp.path, "discord-users.json");
  const directory = new DiscordUserDirectory(filePath);

  directory.remember(alice);
  await directory.flush();
  const firstSeenAt = directory.resolve("alice")?.firstSeenAt;
  assert.ok(firstSeenAt);

  directory.remember({ ...alice, displayName: "Alice New", username: "alice_new" });
  await directory.flush();

  assert.equal(directory.resolve("alice"), undefined);
  assert.equal(directory.resolve("alice_new")?.id, alice.id);
  assert.equal(directory.resolve("alice_new")?.firstSeenAt, firstSeenAt);

  const reloaded = new DiscordUserDirectory(filePath);
  await reloaded.load();
  assert.equal(reloaded.resolve("alice"), undefined);
  assert.equal(reloaded.resolve("alice_new")?.id, alice.id);
});

test("ignores invalid users and invalid stored entries", async () => {
  await using temp = await createTempDir("klein-discord-users-");
  const filePath = join(temp.path, "discord-users.json");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      users: [
        { ...alice, id: "not-a-number" },
        { ...bob, username: "../escape" },
        {
          bot: false,
          displayName: "Carol",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          id: "323456789012345678",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          username: "carol",
        },
      ],
    }),
    "utf8",
  );

  const directory = new DiscordUserDirectory(filePath);
  await directory.load();

  assert.equal(directory.resolve("alice"), undefined);
  assert.equal(directory.resolve("bob"), undefined);
  assert.equal(directory.resolve("carol")?.id, "323456789012345678");

  directory.remember({ ...alice, id: "not-a-number" });
  directory.remember({ ...alice, username: "../escape" });
  assert.deepEqual(
    directory.list().map((user) => user.username),
    ["carol"],
  );
});

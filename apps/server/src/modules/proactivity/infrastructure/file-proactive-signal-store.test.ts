import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "bun:test";

import {
  markSignalDismissed,
  markSignalSurfaced,
  type ProactiveSignal,
} from "../domain/proactive-signal";
import { FileProactiveSignalStore } from "./file-proactive-signal-store";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "klein-proactive-signals-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const base: ProactiveSignal = {
  version: 1,
  id: "signal-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  audience: "owner",
  source: { kind: "watch", ref: "watch-1" },
  topic: "weather",
  summary: "雨が降りそう",
  urgency: "today",
  dedupeKey: "dedupe-1",
  observedAt: "2026-11-20T00:00:00.000Z",
  status: "queued",
};

function makeSignal(id: string, overrides: Partial<ProactiveSignal> = {}): ProactiveSignal {
  return { ...base, id, dedupeKey: `dedupe-${id}`, ...overrides };
}

test("stores and updates signals", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactiveSignalStore(directory);
    await store.create(base);

    assert.deepEqual(await store.get(base.id), base);
    assert.deepEqual(await store.get("missing"), undefined);

    const surfaced = markSignalSurfaced(base, "attach", Date.parse("2026-11-20T01:00:00.000Z"), [
      "message-1",
    ]);
    await store.update(surfaced);
    assert.deepEqual(await store.get(base.id), surfaced);
  });
});

test("finds queued, surfaced, and dismissed signals by dedupe key", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactiveSignalStore(directory);
    const queued = makeSignal("queued", { dedupeKey: "key-queued" });
    const surfaced = markSignalSurfaced(
      makeSignal("surfaced", { dedupeKey: "key-surfaced" }),
      "attach",
      Date.parse("2026-11-20T01:00:00.000Z"),
    );
    const dismissed = markSignalDismissed(
      makeSignal("dismissed", { dedupeKey: "key-dismissed" }),
      Date.now(),
    );
    const expired = makeSignal("expired", { dedupeKey: "key-expired", status: "expired" });

    await Promise.all([queued, surfaced, dismissed, expired].map((signal) => store.create(signal)));

    assert.deepEqual(await store.findActiveByDedupeKey("key-queued"), queued);
    assert.deepEqual(await store.findActiveByDedupeKey("key-surfaced"), surfaced);
    assert.deepEqual(await store.findActiveByDedupeKey("key-dismissed"), dismissed);
    assert.deepEqual(await store.findActiveByDedupeKey("key-expired"), undefined);
    assert.deepEqual(await store.findActiveByDedupeKey("unknown"), undefined);
  });
});

test("returns the newest non-expired signal for a dedupe key", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactiveSignalStore(directory);
    const older = makeSignal("older", {
      dedupeKey: "shared",
      observedAt: "2026-11-20T00:00:00.000Z",
    });
    const newer = makeSignal("newer", {
      dedupeKey: "shared",
      observedAt: "2026-11-20T02:00:00.000Z",
    });
    const expired = makeSignal("expired", {
      dedupeKey: "shared",
      observedAt: "2026-11-20T03:00:00.000Z",
      status: "expired",
    });

    await Promise.all([newer, expired, older].map((signal) => store.create(signal)));

    assert.deepEqual(await store.findActiveByDedupeKey("shared"), newer);
  });
});

test("lists queued signals by scope and planned delivery mode", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactiveSignalStore(directory);
    const attach = makeSignal("attach", { delivery: { mode: "attach" } });
    const digest = makeSignal("digest", {
      delivery: { mode: "digest" },
      observedAt: "2026-11-20T00:01:00.000Z",
    });
    const plain = makeSignal("plain", { observedAt: "2026-11-20T00:02:00.000Z" });
    const surfaced = markSignalSurfaced(
      makeSignal("surfaced"),
      "attach",
      Date.parse("2026-11-20T01:00:00.000Z"),
    );
    const otherChannel = makeSignal("other-channel", {
      channelId: "channel-b",
      observedAt: "2026-11-20T00:03:00.000Z",
    });
    const publicScope = makeSignal("public-scope", {
      accessScope: "public",
      observedAt: "2026-11-20T00:04:00.000Z",
    });
    const otherChannelPublic = makeSignal("other-channel-public", {
      channelId: "channel-b",
      accessScope: "public",
      observedAt: "2026-11-20T00:05:00.000Z",
    });

    await Promise.all(
      [attach, digest, plain, surfaced, otherChannel, publicScope, otherChannelPublic].map(
        (signal) => store.create(signal),
      ),
    );

    assert.deepEqual(await store.listQueued("channel-a", "owner:123"), [attach, digest, plain]);
    assert.deepEqual(await store.listQueued("channel-a", "owner:123", "attach"), [attach]);
    assert.deepEqual(await store.listQueued("channel-a", "owner:123", "digest"), [digest]);
    assert.deepEqual(await store.listQueued("channel-a", "owner:123", "silent"), []);
    assert.deepEqual(await store.listQueued("channel-a", "public"), [publicScope]);
    assert.deepEqual(await store.listAllQueued(), [
      attach,
      digest,
      plain,
      otherChannel,
      publicScope,
      otherChannelPublic,
    ]);
  });
});

test("counts surfacing events since a timestamp, including later dismissals", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactiveSignalStore(directory);
    const first = markSignalSurfaced(
      makeSignal("first"),
      "attach",
      Date.parse("2026-11-20T01:00:00.000Z"),
    );
    const second = markSignalDismissed(
      markSignalSurfaced(makeSignal("second"), "digest", Date.parse("2026-11-20T02:00:00.000Z")),
      Date.parse("2026-11-20T03:00:00.000Z"),
    );
    const otherChannel = markSignalSurfaced(
      makeSignal("other-channel", { channelId: "channel-b" }),
      "attach",
      Date.parse("2026-11-20T04:00:00.000Z"),
    );
    const queued = makeSignal("queued");

    await Promise.all([first, second, otherChannel, queued].map((signal) => store.create(signal)));

    assert.equal(
      await store.countSurfacedSince("channel-a", "owner:123", "2026-11-20T01:00:00.000Z"),
      2,
    );
    assert.equal(
      await store.countSurfacedSince("channel-a", "owner:123", "2026-11-20T01:30:00.000Z"),
      1,
    );
    assert.equal(
      await store.countSurfacedSince("channel-a", "owner:123", "2026-11-20T05:00:00.000Z"),
      0,
    );
    assert.equal(
      await store.countSurfacedSince("channel-b", "owner:123", "2026-11-20T01:00:00.000Z"),
      1,
    );
    await assert.rejects(
      store.countSurfacedSince("channel-a", "owner:123", "yesterday"),
      TypeError,
    );
  });
});

test("encodes IDs in file names", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactiveSignalStore(directory);
    const encoded = makeSignal("sig/1");

    await store.create(encoded);

    assert.deepEqual(await readdir(directory), ["sig%2F1.json"]);
    assert.deepEqual(await store.get(encoded.id), encoded);
  });
});

test("raises for corrupt JSON instead of silently dropping a candidate", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactiveSignalStore(directory);
    await writeFile(join(directory, "broken.json"), "not json", "utf8");
    await writeFile(join(directory, "notes.txt"), "ignored", "utf8");

    await assert.rejects(store.get("broken"));
    await assert.rejects(store.findActiveByDedupeKey("dedupe-1"));
    await assert.rejects(store.listQueued("channel-a", "owner:123"));
    await assert.rejects(store.listAllQueued());
    await assert.rejects(
      store.countSurfacedSince("channel-a", "owner:123", "2026-11-20T00:00:00.000Z"),
    );
  });
});

test("treats a missing directory as empty", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactiveSignalStore(join(directory, "missing"));

    assert.deepEqual(await store.get("anything"), undefined);
    assert.deepEqual(await store.findActiveByDedupeKey("dedupe-1"), undefined);
    assert.deepEqual(await store.listQueued("channel-a", "public"), []);
    assert.deepEqual(await store.listAllQueued(), []);
    assert.equal(
      await store.countSurfacedSince("channel-a", "public", "2026-11-20T00:00:00.000Z"),
      0,
    );
  });
});

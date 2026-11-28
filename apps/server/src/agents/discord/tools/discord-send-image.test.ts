import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import type { PromiseGuard } from "../../tools/promise-guard";
import { createDiscordSendImageTool } from "./discord-send-image";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x01]);

test("downloads an https image and sends it with the caption", async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl: string | undefined;
  let typingCount = 0;
  let sent:
    | {
        readonly channelId: string;
        readonly bytes: Uint8Array;
        readonly filename: string;
        readonly caption: string | undefined;
      }
    | undefined;
  let hookCalled = false;

  globalThis.fetch = async (input) => {
    fetchedUrl = input instanceof Request ? input.url : input.toString();
    return new Response(PNG);
  };

  try {
    const tool = createDiscordSendImageTool(
      {
        async sendTyping() {
          typingCount += 1;
        },
        async sendImage(channelId, bytes, filename, caption) {
          sent = { channelId, bytes, filename, caption };
          return ["message-101"];
        },
      },
      "current-channel",
      undefined,
      () => {
        hookCalled = true;
      },
    );

    const result = await tool.execute(
      "tool-call",
      {
        source: "https://cdn.example.com/assets/photo.jpeg?size=large",
        caption: "かわいい",
      },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    );

    assert.equal(fetchedUrl, "https://cdn.example.com/assets/photo.jpeg?size=large");
    assert.equal(typingCount, 1);
    assert.deepEqual(sent, {
      channelId: "current-channel",
      bytes: PNG,
      filename: "photo.png",
      caption: "かわいい",
    });
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: `Sent image photo.png (${PNG.byteLength} bytes) to Discord with caption: かわいい.`,
      },
    ]);
    assert.deepEqual(result.details, { messageIds: ["message-101"] });
    assert.equal(hookCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends an image from a base64 data URI", async () => {
  let sentFilename: string | undefined;
  const tool = createDiscordSendImageTool(
    {
      async sendTyping() {},
      async sendImage(_channelId, _bytes, filename) {
        sentFilename = filename;
        return [];
      },
    },
    "current-channel",
  );
  const dataUri = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

  const result = await tool.execute(
    "tool-call",
    { source: dataUri },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(sentFilename, "image.png");
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: `Sent image image.png (${PNG.byteLength} bytes) to Discord.`,
    },
  ]);
  assert.deepEqual(result.details, {});
});

test("sends an image from an absolute local path", async () => {
  const temp = await mkdtemp(join(tmpdir(), "klein-send-image-"));
  let sent:
    | {
        readonly bytes: Uint8Array;
        readonly filename: string;
        readonly caption: string | undefined;
      }
    | undefined;

  try {
    const path = join(temp, "local.gif");
    await writeFile(path, GIF);
    const tool = createDiscordSendImageTool(
      {
        async sendTyping() {},
        async sendImage(_channelId, bytes, filename, caption) {
          sent = { bytes, filename, caption };
          return ["message-202"];
        },
      },
      "current-channel",
    );

    const result = await tool.execute(
      "tool-call",
      { source: path },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    );

    assert.deepEqual([...(sent?.bytes ?? [])], [...GIF]);
    assert.equal(sent?.filename, "local.gif");
    assert.equal(sent?.caption, undefined);
    assert.deepEqual(result.details, { messageIds: ["message-202"] });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects content that is not a supported image", async () => {
  const originalFetch = globalThis.fetch;
  let sent = false;
  globalThis.fetch = async () => new Response("this is text, not an image");

  try {
    const tool = createDiscordSendImageTool(
      {
        async sendTyping() {},
        async sendImage() {
          sent = true;
          return [];
        },
      },
      "current-channel",
    );

    await assert.rejects(
      tool.execute(
        "tool-call",
        { source: "https://example.com/not-an-image.png" },
        undefined,
        undefined,
        await createStubExtensionToolContext(),
      ),
      /Unsupported image type/u,
    );
    assert.equal(sent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects images larger than 8 MiB", async () => {
  const temp = await mkdtemp(join(tmpdir(), "klein-send-image-large-"));
  let sent = false;

  try {
    const path = join(temp, "large.png");
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    const tool = createDiscordSendImageTool(
      {
        async sendTyping() {},
        async sendImage() {
          sent = true;
          return [];
        },
      },
      "current-channel",
    );

    await assert.rejects(
      tool.execute(
        "tool-call",
        { source: path },
        undefined,
        undefined,
        await createStubExtensionToolContext(),
      ),
      /Image is too large/u,
    );
    assert.equal(sent, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects an unsupported source scheme", async () => {
  let sent = false;
  const tool = createDiscordSendImageTool(
    {
      async sendTyping() {},
      async sendImage() {
        sent = true;
        return [];
      },
    },
    "current-channel",
  );

  await assert.rejects(
    tool.execute(
      "tool-call",
      { source: "ftp://example.com/photo.png" },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /Unsupported image source scheme/u,
  );
  assert.equal(sent, false);
});

test("rejects a relative local path", async () => {
  let sent = false;
  const tool = createDiscordSendImageTool(
    {
      async sendTyping() {},
      async sendImage() {
        sent = true;
        return [];
      },
    },
    "current-channel",
  );

  await assert.rejects(
    tool.execute(
      "tool-call",
      { source: "images/photo.png" },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /must be an absolute path/u,
  );
  assert.equal(sent, false);
});

test("blocks a caption that promises an untracked follow-up", async () => {
  let checkedCaption: string | undefined;
  let sent = false;
  let typingCount = 0;
  const guard: PromiseGuard = {
    async check(content) {
      checkedCaption = content;
      return { action: "block", reason: "no-active-follow-up" };
    },
  };
  const tool = createDiscordSendImageTool(
    {
      async sendTyping() {
        typingCount += 1;
      },
      async sendImage() {
        sent = true;
        return [];
      },
    },
    "current-channel",
    guard,
  );

  await assert.rejects(
    tool.execute(
      "tool-call",
      {
        source: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
        caption: "後で報告します",
      },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /promises a later report.*follow_up_create/u,
  );
  assert.equal(checkedCaption, "後で報告します");
  assert.equal(typingCount, 1);
  assert.equal(sent, false);
});

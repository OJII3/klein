import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";

import { Type } from "typebox";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { PromiseGuard } from "../../tools/promise-guard";
import { defineSurfaceTool } from "./surface-tool";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const PROMISE_BLOCK_ERROR =
  "この文面は追跡を約束しているが、この会話に有効な追跡がない。follow_up_create を先に成功させるか、約束しない言い方に変えること。";

export function createDiscordSendImageTool(
  channelApi: Pick<DiscordChannelApi, "sendImage" | "sendTyping">,
  channelId: string,
  guard?: PromiseGuard,
  onMessageSent?: () => void,
) {
  return defineSurfaceTool(
    {
      name: "discord_send_image",
      label: "Send Discord Image",
      exposure: "direct",
      description:
        "Send an image attachment to the current Discord conversation. " +
        "Source must be an https URL, a data: URI, or an absolute local file path.",
      parameters: Type.Object({
        source: Type.String({
          minLength: 1,
          description:
            "An https URL, a data: URI, or an absolute path to a local PNG, JPEG, GIF, or WebP image.",
        }),
        caption: Type.Optional(
          Type.String({ minLength: 1, description: "Optional text to post with the image." }),
        ),
      }),
      async execute(_toolCallId, params) {
        const source = params.source.trim();
        const caption = params.caption?.trim() || undefined;
        await channelApi.sendTyping(channelId);

        const bytes = await readImageBytes(source);
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(
            `Image is too large (${bytes.byteLength} bytes). Discord accepts images up to 8 MiB; use a smaller image.`,
          );
        }

        const imageType = sniffImageType(bytes);
        if (!imageType) {
          throw new Error(
            "Unsupported image type. The source must contain a PNG, JPEG, GIF, or WebP image.",
          );
        }

        if (caption) {
          const decision = await guard?.check(caption);
          if (decision?.action === "block") {
            throw new Error(PROMISE_BLOCK_ERROR);
          }
        }

        const filename = resolveFilename(source, imageType.extension);
        const messageIds = await channelApi.sendImage(channelId, bytes, filename, caption);
        onMessageSent?.();

        return {
          content: [
            {
              type: "text",
              text: `Sent image ${filename} (${bytes.byteLength} bytes) to Discord${
                caption ? ` with caption: ${caption}` : ""
              }.`,
            },
          ],
          details: messageIds.length > 0 ? { messageIds } : {},
        };
      },
    },
    { outcome: "Sent an image to Discord." },
  );
}

async function readImageBytes(source: string): Promise<Uint8Array> {
  if (/^https:\/\//iu.test(source)) return fetchImage(source);
  if (/^http:\/\//iu.test(source)) {
    throw new Error(
      "Only https URLs are supported. Use an https URL, a data: URI, or an absolute local path.",
    );
  }
  if (/^data:/iu.test(source)) return decodeDataUri(source);
  if (isAbsolute(source)) return readLocalImage(source);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) {
    throw new Error(
      "Unsupported image source scheme. Use an https URL, a data: URI, or an absolute local path.",
    );
  }
  throw new Error(
    "A local image source must be an absolute path. Use an https URL, a data: URI, or an absolute local path.",
  );
}

async function readLocalImage(source: string): Promise<Uint8Array> {
  try {
    return await readFile(source);
  } catch (error) {
    throw new Error(
      `Could not read the local image file at ${source}. Check that the absolute path exists and is readable.`,
      { cause: error },
    );
  }
}

async function fetchImage(source: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(source);
  } catch (error) {
    throw new Error(
      `Could not download the image from ${source}. Check the URL and network access.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `Image download failed with HTTP ${response.status}. Check that the URL points to a reachable image.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function decodeDataUri(source: string): Uint8Array {
  const commaIndex = source.indexOf(",");
  if (commaIndex < 0) {
    throw new Error("Invalid data: URI. Use a base64 data URI such as data:image/png;base64,...");
  }
  const metadata = source.slice("data:".length, commaIndex).toLowerCase();
  if (!metadata.split(";").includes("base64")) {
    throw new Error(
      "Unsupported data: URI. Use a base64 data URI such as data:image/png;base64,...",
    );
  }
  const bytes = Buffer.from(source.slice(commaIndex + 1), "base64");
  if (bytes.byteLength === 0) {
    throw new Error(
      "The data: URI did not contain any image bytes. Check that the payload is base64.",
    );
  }
  return bytes;
}

function sniffImageType(bytes: Uint8Array): { readonly extension: string } | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { extension: "jpg" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { extension: "gif" };
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { extension: "webp" };
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function resolveFilename(source: string, extension: string): string {
  let candidate = "";
  if (/^https:\/\//iu.test(source)) {
    try {
      candidate = decodeURIComponent(basename(new URL(source).pathname));
    } catch {
      candidate = "";
    }
  } else if (!/^data:/iu.test(source)) {
    candidate = basename(source);
  }

  const safeCandidate = toSafeFilenamePart(basename(candidate));
  const currentExtension = extname(safeCandidate);
  const stem =
    currentExtension.length > 0 ? safeCandidate.slice(0, -currentExtension.length) : safeCandidate;
  return `${stem.length > 0 && stem !== "." && stem !== ".." ? stem : "image"}.${extension}`;
}

function toSafeFilenamePart(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    safe += code < 0x20 || '<>:"/\\|?*'.includes(character) ? "_" : character;
  }
  return safe;
}

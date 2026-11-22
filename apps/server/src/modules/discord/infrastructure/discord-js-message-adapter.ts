import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import {
  resolveDiscordMentions,
  type DiscordChannelHistoryMessage,
  type DiscordImageAttachment,
  type DiscordMessage,
  type DiscordReplyReference,
  type DiscordUser,
} from "../domain/discord-message";
import type {
  DiscordGatewayAttachment,
  DiscordGatewayChannel,
  DiscordGatewayMessage,
  DiscordGatewayMessageReader,
} from "../ports/discord-gateway-message";

export type DiscordAdapterAttachment = DiscordGatewayAttachment;
export type DiscordAdapterChannel = DiscordGatewayChannel;
export type DiscordAdapterMessage = DiscordGatewayMessage;

const IMAGE_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function normalizeImageMimeType(contentType: string | null): string | undefined {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const normalizedMimeType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  if (!normalizedMimeType || !IMAGE_MIME_TYPES.has(normalizedMimeType)) return undefined;
  return normalizedMimeType;
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > IMAGE_MAX_DOWNLOAD_BYTES) {
    throw new Error("Discord image attachment exceeds the download size limit");
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > IMAGE_MAX_DOWNLOAD_BYTES) {
      throw new Error("Discord image attachment exceeds the download size limit");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > IMAGE_MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error("Discord image attachment exceeds the download size limit");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function toDiscordUser(message: DiscordAdapterMessage): DiscordUser {
  return {
    bot: message.author.bot,
    id: message.author.id,
    username: message.author.username,
    displayName: message.member?.displayName ?? message.author.displayName,
  };
}

export class DiscordJsMessageAdapter implements DiscordGatewayMessageReader {
  constructor(private readonly logger?: Logger) {}

  hasSupportedImageAttachment(message: DiscordAdapterMessage): boolean {
    return [...message.attachments.values()].some(
      (attachment) => normalizeImageMimeType(attachment.contentType) !== undefined,
    );
  }

  toDiscordMessage(message: DiscordAdapterMessage): DiscordMessage {
    const thread = message.channel.isThread() ? message.channel : undefined;
    const channelName =
      "name" in message.channel && typeof message.channel.name === "string"
        ? message.channel.name
        : "";

    return {
      occurredAt: message.createdAt.toISOString(),
      author: toDiscordUser(message),
      channelId: message.channelId,
      ...(channelName ? { channelName } : {}),
      content: this.normalizeMessageContent(message),
      guildId: message.guildId ?? undefined,
      id: message.id,
      images: [],
      parentChannelId: thread?.parentId ?? undefined,
      threadId: thread?.id,
    };
  }

  toDiscordChannelHistoryMessage(message: DiscordAdapterMessage): DiscordChannelHistoryMessage {
    return {
      occurredAt: message.createdAt.toISOString(),
      author: toDiscordUser(message),
      channelId: message.channelId,
      content: this.normalizeMessageContent(message),
      id: message.id,
      attachments: [...message.attachments.values()].map((attachment) => ({
        filename: attachment.name,
        url: attachment.url,
      })),
    };
  }

  async fetchImages(message: DiscordAdapterMessage): Promise<DiscordImageAttachment[]> {
    const imageAttachments = [...message.attachments.values()].filter(
      (attachment) => normalizeImageMimeType(attachment.contentType) !== undefined,
    );

    const images = await Promise.all(
      imageAttachments.map(async (attachment) => {
        try {
          return await this.fetchImage(attachment);
        } catch (error) {
          this.logger?.warn(
            {
              attachmentId: attachment.id,
              err: error,
              event: "discord_image_attachment_fetch_failed",
              messageId: message.id,
            },
            "Failed to fetch Discord image attachment",
          );
          return undefined;
        }
      }),
    );

    return images.filter((image): image is DiscordImageAttachment => image !== undefined);
  }

  async fetchReplyReference(
    message: DiscordAdapterMessage,
  ): Promise<DiscordReplyReference | undefined> {
    const messageId = message.reference?.messageId;
    if (!messageId) return undefined;
    if (message.reference?.channelId && message.reference.channelId !== message.channelId) {
      return { id: messageId };
    }

    try {
      const referencedMessage = await message.fetchReference();
      if (referencedMessage.channelId && referencedMessage.channelId !== message.channelId) {
        return { id: messageId };
      }
      return {
        author: toDiscordUser(referencedMessage),
        content: this.normalizeMessageContent(referencedMessage),
        id: referencedMessage.id,
      };
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_reply_reference_fetch_failed",
          messageId,
        },
        "Failed to fetch Discord reply reference",
      );
      return { id: messageId };
    }
  }

  private async fetchImage(attachment: DiscordAdapterAttachment): Promise<DiscordImageAttachment> {
    const mimeType = normalizeImageMimeType(attachment.contentType);
    if (!mimeType) {
      throw new Error(`Unsupported Discord image type: ${attachment.contentType ?? "unknown"}`);
    }
    if (attachment.size > IMAGE_MAX_DOWNLOAD_BYTES) {
      throw new Error("Discord image attachment exceeds the download size limit");
    }

    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Discord image attachment returned HTTP ${response.status}`);
    }

    const processed = await resizeImage(await readResponseBytes(response), mimeType);
    if (!processed) {
      throw new Error("Discord image attachment could not be normalized");
    }

    return {
      data: processed.data,
      filename: attachment.name,
      id: attachment.id,
      mimeType: processed.mimeType,
    };
  }

  private normalizeMessageContent(message: DiscordAdapterMessage): string {
    const content = message.content.trim();

    return resolveDiscordMentions(content, {
      user: (userId) => {
        const user = message.mentions.users.get(userId);
        if (!user) return undefined;

        return {
          bot: user.bot,
          id: user.id,
          username: user.username,
          displayName: message.mentions.members?.get(userId)?.displayName ?? user.displayName,
        };
      },
      role: (roleId) => {
        const role = message.mentions.roles.get(roleId);
        return role ? { id: role.id, name: role.name } : undefined;
      },
    });
  }
}

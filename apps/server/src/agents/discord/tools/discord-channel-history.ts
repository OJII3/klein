import { randomUUID } from "node:crypto";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  formatDiscordChannelHistoryMessage,
  type DiscordChannelHistoryMessage,
  type DiscordChannelHistoryOrder,
} from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { isRecord } from "@shared/type-guards";

const DEFAULT_CHANNEL_HISTORY_LIMIT = 30;
const MAX_CHANNEL_HISTORY_LIMIT = 100;
const MAX_STORED_CHANNEL_HISTORIES = 20;

const channelHistoryOrderSchema = Type.Union([Type.Literal("newest"), Type.Literal("oldest")], {
  default: "newest",
  description: 'Output order. "newest" (default) puts recent messages first; "oldest" reverses it.',
});

const channelHistoryContentParameters = Type.Object({
  responseId: Type.String({ minLength: 1 }),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, default: 0, description: "First message index. Defaults to 0." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_CHANNEL_HISTORY_LIMIT,
      default: DEFAULT_CHANNEL_HISTORY_LIMIT,
      description: `Number of messages to read, from 1 to ${MAX_CHANNEL_HISTORY_LIMIT}. Defaults to ${DEFAULT_CHANNEL_HISTORY_LIMIT}.`,
    }),
  ),
});

interface DiscordChannelHistoryContentDetails {
  readonly found: boolean;
  readonly responseId: string;
  readonly channelId?: string;
  readonly order?: DiscordChannelHistoryOrder;
  readonly offset?: number;
  readonly limit?: number;
  readonly returned?: number;
  readonly total?: number;
}

export interface StoredDiscordChannelHistory {
  readonly responseId: string;
  readonly channelId: string;
  readonly order: DiscordChannelHistoryOrder;
  readonly messages: readonly DiscordChannelHistoryMessage[];
}

export class DiscordChannelHistoryStore {
  private readonly entries = new Map<string, StoredDiscordChannelHistory>();

  save(entry: Omit<StoredDiscordChannelHistory, "responseId">): string {
    const responseId = randomUUID();
    this.entries.set(responseId, { responseId, ...entry });
    while (this.entries.size > MAX_STORED_CHANNEL_HISTORIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return responseId;
  }

  get(responseId: string): StoredDiscordChannelHistory | undefined {
    return this.entries.get(responseId);
  }
}

export function createDiscordChannelHistoryTool(
  channelApi: Pick<DiscordChannelApi, "readMessages">,
  currentChannelId: string,
  store: DiscordChannelHistoryStore,
  requester?: Parameters<DiscordChannelApi["readMessages"]>[1],
) {
  return defineTool({
    name: "discord_channel_history",
    label: "Read Discord Channel History",
    description:
      "Read recent messages from a specific Discord channel, including messages from bots. " +
      `channelId is required; this conversation's channel is ${currentChannelId}. ` +
      "Messages come newest first by default; pass order to read them oldest first. " +
      "Use before or after with a message ID to page through older or newer messages; they cannot be combined. " +
      "Long message bodies are truncated. The untruncated text is kept under a responseId that discord_channel_history_content can page through.",
    parameters: Type.Object({
      channelId: Type.String({
        minLength: 1,
        description: `Channel ID (required). This conversation's channel is ${currentChannelId}.`,
      }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_CHANNEL_HISTORY_LIMIT,
          default: DEFAULT_CHANNEL_HISTORY_LIMIT,
          description: `Number of messages to read, from 1 to ${MAX_CHANNEL_HISTORY_LIMIT}. Defaults to ${DEFAULT_CHANNEL_HISTORY_LIMIT}.`,
        }),
      ),
      order: Type.Optional(channelHistoryOrderSchema),
      before: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Return messages older than this message ID.",
        }),
      ),
      after: Type.Optional(
        Type.String({ minLength: 1, description: "Return messages newer than this message ID." }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!params.channelId) {
        throw new Error(
          `channelId は必須です。この会話の現在のチャンネルは ${currentChannelId} です。`,
        );
      }
      if (params.before && params.after) {
        throw new Error(
          "before と after は同時に指定できません。どちらか一方でページングしてください。",
        );
      }

      const channelId = params.channelId;
      const limit = clampChannelHistoryLimit(params.limit);
      const order = params.order ?? "newest";

      let messages: readonly DiscordChannelHistoryMessage[];
      try {
        messages = await channelApi.readMessages(
          {
            channelId,
            limit,
            ...(params.before ? { before: params.before } : {}),
            ...(params.after ? { after: params.after } : {}),
          },
          requester,
        );
      } catch (error) {
        throw new Error(describeDiscordChannelHistoryError(error, channelId), { cause: error });
      }

      const orderedMessages = order === "oldest" ? messages.toReversed() : messages;
      const responseId = store.save({ channelId, order, messages: orderedMessages });
      const header = `Discordチャンネル履歴: channelId=${channelId}, order=${order}, count=${orderedMessages.length}`;
      const body =
        orderedMessages.length > 0
          ? orderedMessages
              .map((message) => formatDiscordChannelHistoryMessage(message))
              .join("\n\n")
          : "メッセージはありませんでした。";

      return {
        content: [
          {
            type: "text",
            text:
              `${header}\n\n${body}\n\n` +
              `全文（切り詰めていない本文）は responseId "${responseId}" に保存されています。` +
              `discord_channel_history_content({ responseId: "${responseId}", offset: 0, limit: ${DEFAULT_CHANNEL_HISTORY_LIMIT} }) で取得できます。`,
          },
        ],
        details: {
          channelId,
          order,
          responseId,
          messageIds: orderedMessages.map((message) => message.id),
        },
      };
    },
  });
}

export function createDiscordChannelHistoryContentTool(store: DiscordChannelHistoryStore) {
  return defineTool<typeof channelHistoryContentParameters, DiscordChannelHistoryContentDetails>({
    name: "discord_channel_history_content",
    label: "Read Stored Discord History",
    description:
      "Read the untruncated messages stored by discord_channel_history, by responseId. " +
      "offset and limit page through the stored messages, not the channel.",
    parameters: channelHistoryContentParameters,
    async execute(_toolCallId, params) {
      const stored = store.get(params.responseId);
      if (!stored) {
        return {
          content: [
            {
              type: "text",
              text:
                `responseId "${params.responseId}" の保存内容が見つかりません。` +
                "discord_channel_history を実行して新しい responseId を取得してください。",
            },
          ],
          details: { found: false, responseId: params.responseId },
        };
      }

      if (stored.messages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `responseId "${params.responseId}" に保存されたメッセージはありません。`,
            },
          ],
          details: {
            found: true,
            responseId: stored.responseId,
            channelId: stored.channelId,
            total: 0,
          },
        };
      }

      const offset = params.offset ?? 0;
      if (offset >= stored.messages.length) {
        return {
          content: [
            {
              type: "text",
              text:
                `offset ${offset} は範囲外です。responseId "${params.responseId}" のメッセージは ` +
                `0-${stored.messages.length - 1} の範囲で指定してください。`,
            },
          ],
          details: {
            found: true,
            responseId: stored.responseId,
            channelId: stored.channelId,
            total: stored.messages.length,
          },
        };
      }

      const limit = clampChannelHistoryLimit(params.limit);
      const end = Math.min(offset + limit, stored.messages.length);
      const page = stored.messages.slice(offset, end);
      const header =
        `responseId: ${stored.responseId} / channelId: ${stored.channelId} / ` +
        `order=${stored.order} / ${offset + 1}-${end} of ${stored.messages.length}`;
      const footer =
        end < stored.messages.length
          ? `\n\n続きは discord_channel_history_content({ responseId: "${stored.responseId}", offset: ${end}, limit: ${limit} }) で取得できます。`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n${page.map((message) => formatDiscordChannelHistoryMessage(message, Number.POSITIVE_INFINITY)).join("\n\n")}${footer}`,
          },
        ],
        details: {
          found: true,
          responseId: stored.responseId,
          channelId: stored.channelId,
          order: stored.order,
          offset,
          limit,
          returned: page.length,
          total: stored.messages.length,
        },
      };
    },
  });
}

function clampChannelHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_CHANNEL_HISTORY_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_CHANNEL_HISTORY_LIMIT);
}

function describeDiscordChannelHistoryError(error: unknown, channelId: string): string {
  const context = `Discord の履歴を取得できません (channelId=${channelId})`;
  const details = isRecord(error) ? error : {};
  const code = typeof details.code === "number" ? details.code : undefined;
  const status = typeof details.status === "number" ? details.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (status === 429 || normalized.includes("rate limit")) {
    return `${context}: Discord のレート制限に達しました (429)。しばらく待ってからもう一度試してください。`;
  }
  if (code === 50013 || normalized.includes("missing permissions")) {
    return `${context}: Bot にチャンネル履歴の閲覧権限がありません (Missing Permissions)。チャンネルの権限設定で「メッセージ履歴を読む」を許可してください。`;
  }
  if (code === 50001 || normalized.includes("missing access")) {
    return `${context}: Bot がこのチャンネルにアクセスできません (Missing Access)。チャンネルIDと権限設定を確認してください。`;
  }
  if (code === 10003 || normalized.includes("unknown channel")) {
    return `${context}: チャンネルが見つかりません (Unknown Channel)。チャンネルIDを確認してください。`;
  }
  if (code === 10008 || normalized.includes("unknown message")) {
    return `${context}: 指定したメッセージが見つかりません (Unknown Message)。before と after のIDを確認してください。`;
  }
  if (normalized.includes("access denied")) {
    return `${context}: このチャンネルの履歴を読む権限がありません。`;
  }
  if (normalized.includes("cannot contain messages")) {
    return `${context}: このチャンネルはテキストチャンネルではありません。`;
  }
  return `${context}: ${message}`;
}

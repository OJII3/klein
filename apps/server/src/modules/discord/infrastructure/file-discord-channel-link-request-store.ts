import { Type } from "typebox";

import type { PendingDiscordChannelLinkRequest } from "../domain/discord-channel-link-request";
import { FileDiscordApprovalRequestStore } from "./file-discord-approval-request-store";

const DiscordIdSchema = Type.String({ minLength: 1, pattern: "^[0-9]+$" });

const PendingDiscordChannelLinkRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    guildId: DiscordIdSchema,
    channelId: DiscordIdSchema,
    threadId: Type.Optional(DiscordIdSchema),
    pendingChannelId: DiscordIdSchema,
    channelName: Type.Optional(Type.String({ minLength: 1 })),
    requesterUserId: DiscordIdSchema,
    pendingMessageId: Type.Optional(Type.String({ minLength: 1 })),
    expiresAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export class FileDiscordChannelLinkRequestStore extends FileDiscordApprovalRequestStore<PendingDiscordChannelLinkRequest> {
  constructor(filePath: string) {
    super(filePath, PendingDiscordChannelLinkRequestSchema, "Discord channel link requests");
  }
}

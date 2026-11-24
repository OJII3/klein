import { Type } from "typebox";

import type { PendingDiscordAccessRequest } from "../domain/discord-access-request";
import { FileDiscordApprovalRequestStore } from "./file-discord-approval-request-store";

const DiscordIdSchema = Type.String({ minLength: 1, pattern: "^[0-9]+$" });

const PendingDiscordAccessRequestSchema = Type.Object(
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

export class FileDiscordAccessRequestStore extends FileDiscordApprovalRequestStore<PendingDiscordAccessRequest> {
  constructor(filePath: string) {
    super(filePath, PendingDiscordAccessRequestSchema, "Discord access requests");
  }
}

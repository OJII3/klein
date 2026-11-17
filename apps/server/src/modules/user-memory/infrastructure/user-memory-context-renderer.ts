import {
  hasUserMemoryContent,
  type UserMemory,
  type UserMemoryIdentity,
} from "../domain/user-memory";
import { renderUserMemory } from "./markdown-user-memory-store";

/**
 * Describes a user who speaks in a Pi session for the first time, with their memory when one
 * exists. An empty memory is presented as a first meeting instead of as an empty document.
 */
export function renderFirstSpeakerUserMemory(
  identity: UserMemoryIdentity,
  memory: UserMemory | undefined,
): string {
  const person =
    identity.displayName === identity.username
      ? identity.displayName
      : `${identity.displayName} (@${identity.username})`;

  if (!memory || !hasUserMemoryContent(memory)) {
    return `This is the first message from ${person} in this conversation, and there is no stored memory of them yet. This is your first meeting.`;
  }

  return `This is the first message from ${person} in this conversation. Their memory from past conversations follows.\n\n${renderUserMemory(memory).trim()}`;
}

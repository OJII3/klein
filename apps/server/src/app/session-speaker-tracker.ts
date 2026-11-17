/**
 * Remembers which users have spoken in the current Pi session of each conversation. A rotated
 * conversation starts a new session key, so its speakers are forgotten with the old session.
 */
export class SessionSpeakerTracker {
  private readonly speakers = new Map<string, { sessionKey: string; userIds: Set<string> }>();

  /** Returns true only the first time the user speaks in the given session. */
  observe(conversation: string, sessionKey: string, userId: string): boolean {
    const current = this.speakers.get(conversation);
    if (current?.sessionKey !== sessionKey) {
      this.speakers.set(conversation, { sessionKey, userIds: new Set([userId]) });
      return true;
    }

    if (current.userIds.has(userId)) return false;
    current.userIds.add(userId);
    return true;
  }

  clear(): void {
    this.speakers.clear();
  }
}

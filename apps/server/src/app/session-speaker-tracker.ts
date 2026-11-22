export class SessionSpeakerTracker {
  private readonly speakers = new Map<string, { sessionKey: string; userIds: Set<string> }>();

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

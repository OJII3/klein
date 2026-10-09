interface SessionCursor {
  readonly sessionId: string;
  readonly beforeEntryId: string;
}

interface SessionListCursor {
  readonly beforeSessionId: string;
}

export function encodeSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function encodeSessionListCursor(cursor: SessionListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSessionCursor(value: string, sessionId: string): SessionCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid session cursor");
  }

  if (
    !isRecord(decoded) ||
    decoded.sessionId !== sessionId ||
    typeof decoded.beforeEntryId !== "string" ||
    decoded.beforeEntryId.length === 0
  ) {
    throw new Error("Invalid session cursor");
  }

  return { beforeEntryId: decoded.beforeEntryId, sessionId: decoded.sessionId };
}

export function decodeSessionListCursor(value: string): SessionListCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid session list cursor");
  }

  if (
    !isRecord(decoded) ||
    typeof decoded.beforeSessionId !== "string" ||
    decoded.beforeSessionId.length === 0
  ) {
    throw new Error("Invalid session list cursor");
  }

  return { beforeSessionId: decoded.beforeSessionId };
}

export function normalizeSessionLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("Session event limit must be an integer between 1 and 200");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

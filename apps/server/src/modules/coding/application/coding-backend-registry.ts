import { parseCodingSessionRef } from "../domain/coding-session";
import type { CodingBackend } from "../ports/coding-backend";

export interface ResolvedCodingSession {
  readonly backend: CodingBackend;
  readonly sessionId: string;
}

export class CodingBackendRegistry {
  private readonly backends: ReadonlyMap<string, CodingBackend>;
  readonly defaultId: string;

  constructor(backends: readonly CodingBackend[], defaultId?: string) {
    if (backends.length === 0) {
      throw new Error("At least one coding backend is required");
    }
    const byId = new Map<string, CodingBackend>();
    for (const backend of backends) {
      if (byId.has(backend.id)) {
        throw new Error(`Duplicate coding backend id: ${backend.id}`);
      }
      byId.set(backend.id, backend);
    }
    const resolvedDefault = defaultId ?? backends[0]?.id;
    if (!resolvedDefault) {
      throw new Error("A default coding backend is required");
    }
    if (!byId.has(resolvedDefault)) {
      throw new Error(`Unknown default coding backend: ${resolvedDefault}`);
    }
    this.backends = byId;
    this.defaultId = resolvedDefault;
  }

  list(): readonly CodingBackend[] {
    return [...this.backends.values()];
  }

  get(id?: string): CodingBackend {
    const resolved = id ?? this.defaultId;
    const backend = this.backends.get(resolved);
    if (!backend) {
      throw new Error(
        `Unknown coding backend "${resolved}". Available: ${this.list()
          .map((candidate) => candidate.id)
          .join(", ")}.`,
      );
    }
    return backend;
  }

  resolve(sessionRef: string): ResolvedCodingSession {
    const parsed = parseCodingSessionRef(sessionRef);
    if (parsed && this.backends.has(parsed.backendId)) {
      return { backend: this.get(parsed.backendId), sessionId: parsed.sessionId };
    }
    return { backend: this.get(), sessionId: sessionRef };
  }
}

import type { AuthRequest } from "../domain/auth-request";

/** Persists pending direct-message requests across restarts. */
export interface AuthRequestStore {
  load(): Promise<void>;
  list(): readonly AuthRequest[];
  save(request: AuthRequest): Promise<void>;
  remove(requestId: string): Promise<void>;
}

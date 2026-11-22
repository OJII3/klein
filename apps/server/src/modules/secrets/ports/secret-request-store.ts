import type { SecretRequest } from "../domain/secret-request";

/** Persists pending direct-message requests across restarts. */
export interface SecretRequestStore {
  load(): Promise<void>;
  list(): readonly SecretRequest[];
  save(request: SecretRequest): Promise<void>;
  remove(requestId: string): Promise<void>;
}

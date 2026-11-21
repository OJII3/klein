import type {
  ProactivePreferenceChange,
  ProactivePreferences,
} from "../domain/proactive-preference";
import type { ProactivePreferenceTarget } from "../domain/proactive-preference-scope";

export interface StoredProactivePreferences {
  /** File key such as `user-123` or `channel-456`. */
  readonly key: string;
  readonly preferences: ProactivePreferences;
}

export interface ProactivePreferenceStore {
  read(target: ProactivePreferenceTarget): Promise<ProactivePreferences>;
  list(): Promise<readonly StoredProactivePreferences[]>;
  update(
    target: ProactivePreferenceTarget,
    change: ProactivePreferenceChange,
  ): Promise<ProactivePreferences>;
}

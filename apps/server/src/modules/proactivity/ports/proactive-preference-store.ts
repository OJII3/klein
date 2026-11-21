import type {
  ProactivePreferenceChange,
  ProactivePreferences,
} from "../domain/proactive-preference";
import type { ProactivePreferenceTarget } from "../domain/proactive-preference-scope";

export interface ProactivePreferenceStore {
  read(target: ProactivePreferenceTarget): Promise<ProactivePreferences>;
  update(
    target: ProactivePreferenceTarget,
    change: ProactivePreferenceChange,
  ): Promise<ProactivePreferences>;
}

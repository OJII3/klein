import type {
  ProactivePreferenceChange,
  ProactivePreferences,
} from "../domain/proactive-preference";

export interface ProactivePreferenceStore {
  read(): Promise<ProactivePreferences>;
  update(change: ProactivePreferenceChange): Promise<ProactivePreferences>;
}

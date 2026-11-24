import { resolve } from "node:path";

import type { AppConfig } from "@app/config-schema";

import type { ProactivePolicyDefaults } from "../domain/proactive-delivery-policy";

const DEFAULT_PROACTIVE_DELIVERY_MODE = "attach";
const DEFAULT_PROACTIVE_MAX_PER_DAY = 3;
const DEFAULT_PROACTIVE_PUBLIC_CHANNELS = false;
const DEFAULT_PROMISE_GUARD = "log";

export interface ResolvedProactivityConfig {
  readonly enabled: boolean;
  readonly preferencesDirectory: string;
  readonly followUpDirectory: string;
  readonly signalDirectory: string;
  readonly defaults: ProactivePolicyDefaults;
  readonly promiseGuard: "off" | "log" | "block";
}

export function resolveProactivityConfig(
  config: AppConfig,
  stateDir: string,
): ResolvedProactivityConfig {
  const proactivity = config.features.proactivity;

  return {
    enabled: proactivity?.enabled ?? false,
    preferencesDirectory: resolve(
      proactivity?.preferencesDirectory ?? resolve(stateDir, "proactive/preferences"),
    ),
    followUpDirectory: resolve(
      proactivity?.followUpDirectory ?? resolve(stateDir, "proactive/follow-ups"),
    ),
    signalDirectory: resolve(
      proactivity?.signalDirectory ?? resolve(stateDir, "proactive/signals"),
    ),
    defaults: {
      defaultMode: proactivity?.defaultMode ?? DEFAULT_PROACTIVE_DELIVERY_MODE,
      ...(proactivity?.quietHours ? { quietHours: { ...proactivity.quietHours } } : {}),
      ...(proactivity?.digestAt ? { digestAt: proactivity.digestAt } : {}),
      maxPerDay: proactivity?.maxPerDay ?? DEFAULT_PROACTIVE_MAX_PER_DAY,
      publicChannels: proactivity?.publicChannels ?? DEFAULT_PROACTIVE_PUBLIC_CHANNELS,
    },
    promiseGuard: proactivity?.promiseGuard ?? DEFAULT_PROMISE_GUARD,
  };
}

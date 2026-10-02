import { resolve } from "node:path";

export const DEFAULT_PROFILE = "klein";

export interface ProfilePaths {
  readonly systemPromptFile: string;
  readonly skillsDirectory: string;
}

export function resolveProfile(profile = DEFAULT_PROFILE): ProfilePaths {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile)) {
    throw new Error(`Invalid profile name: ${profile}`);
  }

  const profileDirectory = resolve(process.cwd(), "config", profile);
  return {
    systemPromptFile: resolve(profileDirectory, "SOUL.md"),
    skillsDirectory: resolve(profileDirectory, "skills"),
  };
}

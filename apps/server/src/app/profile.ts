import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

export const DEFAULT_PROFILE = "klein";

const ProfileMetadataSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, pattern: "\\S" }),
  },
  { additionalProperties: false },
);

export interface ProfilePaths {
  readonly displayName: string;
  readonly profileFile: string;
  readonly systemPromptFile: string;
  readonly voiceSystemPromptFile: string;
  readonly skillsDirectory: string;
}

export interface LoadedProfile extends ProfilePaths {
  readonly characterName: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function resolveProfile(
  profile = DEFAULT_PROFILE,
  baseDirectory = process.cwd(),
): ProfilePaths {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile)) {
    throw new Error(`Invalid profile name: ${profile}`);
  }

  const profileDirectory = resolve(baseDirectory, "config", profile);
  return {
    displayName: profile
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    profileFile: resolve(profileDirectory, "profile.json"),
    systemPromptFile: resolve(profileDirectory, "SOUL.md"),
    voiceSystemPromptFile: resolve(profileDirectory, "SOUL.voice.md"),
    skillsDirectory: resolve(profileDirectory, "skills"),
  };
}

export async function loadProfile(
  profile = DEFAULT_PROFILE,
  baseDirectory = process.cwd(),
): Promise<LoadedProfile> {
  const paths = resolveProfile(profile, baseDirectory);

  let content: string;
  try {
    content = await readFile(paths.profileFile, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Profile metadata was not found: ${paths.profileFile}`, {
        cause: error,
      });
    }

    throw new Error(`Failed to read profile metadata: ${paths.profileFile}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Profile metadata is not valid JSON: ${paths.profileFile}`, {
      cause: error,
    });
  }

  if (!Check(ProfileMetadataSchema, parsed)) {
    const errors = Errors(ProfileMetadataSchema, parsed)
      .slice(0, 5)
      .map((error) => `${error.instancePath || "$"}: ${error.message}`)
      .join("; ");

    throw new Error(`Profile metadata is invalid: ${paths.profileFile}. ${errors}`);
  }

  return {
    ...paths,
    characterName: parsed.name.trim(),
  };
}

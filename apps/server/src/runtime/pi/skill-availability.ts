import { AGENT_BROWSER_MCP_SERVER_NAME } from "./agent-browser-mcp";
import { ToolAuthorization, type ToolPermissions } from "./tool-permissions";

export type SkillToolRequirement = "browser" | "coding";

export interface SkillToolAvailability {
  readonly browser: boolean;
  readonly coding: boolean;
}

export interface SkillAudienceCapabilities {
  readonly conversation: SkillToolAvailability;
  readonly ownerWorker: SkillToolAvailability;
  readonly linkedUserWorker: SkillToolAvailability;
}

const SKILL_REQUIREMENTS: Readonly<Record<string, SkillToolRequirement>> = {
  "browser-use": "browser",
  "coding-task": "coding",
};

export function skillRequirements(name: string): readonly SkillToolRequirement[] {
  const requirement = SKILL_REQUIREMENTS[name];
  return requirement ? [requirement] : [];
}

export function excludedSkillNamesFor(availability: SkillToolAvailability): ReadonlySet<string> {
  return new Set(
    Object.entries(SKILL_REQUIREMENTS)
      .filter(([, requirement]) => !availability[requirement])
      .map(([name]) => name),
  );
}

export function resolveSkillAudienceCapabilities(
  permissions: ToolPermissions = {},
): SkillAudienceCapabilities {
  const owner = new ToolAuthorization("owner", permissions, undefined, {
    [AGENT_BROWSER_MCP_SERVER_NAME]: "user",
  });
  const linkedUser = new ToolAuthorization("user", permissions, undefined, {
    [AGENT_BROWSER_MCP_SERVER_NAME]: "user",
  });

  return {
    conversation: { browser: false, coding: false },
    ownerWorker: {
      browser: owner.allowsServer(AGENT_BROWSER_MCP_SERVER_NAME),
      coding: owner.allowsTool("coding_task_start"),
    },
    linkedUserWorker: {
      browser: linkedUser.allowsServer(AGENT_BROWSER_MCP_SERVER_NAME),
      coding: false,
    },
  };
}

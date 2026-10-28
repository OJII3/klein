import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { buildAgentTopology, type OwnerConfig } from "./agent-topology";

const ownerConfig = (
  agents: OwnerConfig["agents"],
  communicationChannelId?: string,
): OwnerConfig => ({
  discord: {
    userId: "123456789012345678",
    ...(communicationChannelId ? { communicationChannelId } : {}),
  },
  agents,
});

test("builds typed agent topology and resolves configured prompt files", () => {
  const topology = buildAgentTopology(
    ownerConfig(
      {
        calendar: { channelId: "123456789012345680", promptFile: "prompts/calendar.md" },
        notes: { promptFile: "prompts/notes.md" },
      },
      "123456789012345679",
    ),
  );

  assert.deepEqual(topology.ownerChannelIds, ["123456789012345679", "123456789012345680"]);
  assert.deepEqual(topology.agents.get("calendar"), {
    agentId: "calendar",
    conversationKey: { kind: "agent", agentId: "calendar" },
    channelId: "123456789012345680",
    promptFile: resolve("prompts/calendar.md"),
  });
  assert.equal(topology.agentsByChannelId.get("123456789012345680")?.agentId, "calendar");
  assert.equal(topology.agentsByChannelId.has("123456789012345679"), false);
});

test("rejects the reserved communication agent ID", () => {
  assert.throws(
    () =>
      buildAgentTopology(
        ownerConfig({ communication: { promptFile: "prompts/communication.md" } }),
      ),
    /Domain agent ID "communication" is reserved/,
  );
});

test("rejects duplicate Discord channel assignments", () => {
  assert.throws(
    () =>
      buildAgentTopology(
        ownerConfig(
          {
            calendar: { channelId: "123456789012345680", promptFile: "prompts/calendar.md" },
            tasks: { channelId: "123456789012345680", promptFile: "prompts/tasks.md" },
          },
          "123456789012345679",
        ),
      ),
    /assigned to both "calendar" and "tasks"/,
  );
});

test("rejects a domain channel that conflicts with the communication channel", () => {
  assert.throws(
    () =>
      buildAgentTopology(
        ownerConfig(
          { calendar: { channelId: "123456789012345679", promptFile: "prompts/calendar.md" } },
          "123456789012345679",
        ),
      ),
    /assigned to both "communication" and "calendar"/,
  );
});

test("rejects channel IDs outside the Discord ID schema", () => {
  assert.throws(
    () =>
      buildAgentTopology(
        ownerConfig({
          calendar: { channelId: "calendar-room", promptFile: "prompts/calendar.md" },
        }),
      ),
    /owner\.agents\.calendar\.channelId must match the Discord ID schema/,
  );
});

test("rejects agent IDs outside the configuration schema", () => {
  assert.throws(
    () =>
      buildAgentTopology(
        ownerConfig({
          "Calendar Team": { promptFile: "prompts/calendar.md" },
        } as unknown as OwnerConfig["agents"]),
      ),
    /Invalid domain agent ID "Calendar Team"/,
  );
});

import type { SharedMemory, SharedMemoryScope, SharedMemoryScopeState } from "./shared-memory";

const SHARED_MEMORY_CONTEXT_HEADER = `# Shared Memory

Shared memory across channels in this guild.`;

export function renderSharedMemoryContext(
  states: readonly SharedMemoryScopeState[],
): string | undefined {
  const blocks = states
    .filter(({ memory }) => memory.facts.length > 0 || memory.preferences.length > 0)
    .map(({ memory, scope }) => `## ${formatScope(scope)}\n\n${renderSections(memory)}`);

  if (blocks.length === 0) return undefined;
  return `${SHARED_MEMORY_CONTEXT_HEADER}\n\n${blocks.join("\n\n")}\n`;
}

function renderSections(memory: SharedMemory): string {
  return [
    renderSection("Facts", memory.facts),
    renderSection("Preferences", memory.preferences),
  ].join("\n\n");
}

function renderSection(title: string, items: readonly string[]): string {
  return [`### ${title}`, ...(items.length > 0 ? [renderBullets(items)] : [])].join("\n\n");
}

function renderBullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatScope(scope: SharedMemoryScope): string {
  switch (scope.type) {
    case "guild":
      return "Guild-wide";
    case "channel":
      return `Channel (${scope.channelId})`;
    case "thread":
      return `Thread (${scope.threadId}, channel ${scope.channelId})`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unsupported shared memory scope: ${String(exhaustive)}`);
    }
  }
}

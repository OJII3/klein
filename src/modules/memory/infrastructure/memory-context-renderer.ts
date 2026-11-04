import type { MemoryDocument, MemoryEntryScope } from "../domain/memory";

const MEMORY_CONTEXT_HEADER = `# Guild Memory

Shared memory across channels in this guild.
`;

const OWNER_MEMORY_CONTEXT_HEADER = `# Owner Memory

Shared memory across the owner's communication channels.
`;

export function renderMemoryContext(
  document: MemoryDocument,
  options: {
    readonly includeIds?: boolean;
    readonly includeScopes?: boolean;
    readonly header?: string;
  } = {},
): string {
  const header = options.header ?? MEMORY_CONTEXT_HEADER;
  const blocks = document.entries.map((entry) => {
    const details = [
      `Kind: ${entry.kind}`,
      ...(options.includeScopes === false
        ? []
        : [`Scope: ${formatScope(entry.scope, options.includeIds ?? false)}`]),
      `Updated: ${entry.updatedAt.slice(0, 10)}`,
      ...(options.includeIds ? [`Memory ID: ${entry.id}`] : []),
    ].join(" · ");

    return `### ${entry.title}\n\n_${details}_\n\n${entry.content}`;
  });

  return `${header}${blocks.length > 0 ? `\n${blocks.join("\n\n")}\n` : ""}`;
}

export function renderOwnerMemoryContext(
  document: MemoryDocument,
  options: { readonly includeIds?: boolean } = {},
): string {
  return renderMemoryContext(document, {
    ...options,
    header: OWNER_MEMORY_CONTEXT_HEADER,
    includeScopes: false,
  });
}

function formatScope(scope: MemoryEntryScope, includeIds: boolean): string {
  switch (scope.type) {
    case "channel":
      return includeIds ? `channel:${scope.channelId}` : "channel";
    case "thread":
      return includeIds ? `thread:${scope.threadId} (channel:${scope.channelId})` : "thread";
    default:
      return scope.type;
  }
}

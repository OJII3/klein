import type { MemoryDocument } from "../domain/memory";

const MEMORY_CONTEXT_HEADER = `# Guild Memory

Shared memory across channels in this guild.
`;

const OWNER_MEMORY_CONTEXT_HEADER = `# Owner Memory

Shared memory across the owner's communication channel and domain agents.
`;

export function renderMemoryContext(
  document: MemoryDocument,
  options: { readonly includeIds?: boolean; readonly header?: string } = {},
): string {
  const header = options.header ?? MEMORY_CONTEXT_HEADER;
  const blocks = document.entries.map((entry) => {
    const details = [
      `Kind: ${entry.kind}`,
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
  });
}

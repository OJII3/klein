import type { MemoryDocument } from "../domain/memory";

const MEMORY_CONTEXT_HEADER = `# Guild Memory

Shared memory across channels in this guild.
`;

export function renderMemoryContext(
  document: MemoryDocument,
  options: { readonly includeIds?: boolean } = {},
): string {
  const blocks = document.entries.map((entry) => {
    const details = [
      `Kind: ${entry.kind}`,
      `Updated: ${entry.updatedAt.slice(0, 10)}`,
      ...(options.includeIds ? [`Memory ID: ${entry.id}`] : []),
    ].join(" · ");

    return `### ${entry.title}\n\n_${details}_\n\n${entry.content}`;
  });

  return `${MEMORY_CONTEXT_HEADER}${blocks.length > 0 ? `\n${blocks.join("\n\n")}\n` : ""}`;
}

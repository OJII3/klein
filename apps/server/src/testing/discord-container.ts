import { isRecord } from "@shared/type-guards";

export function containerMessageText(message: {
  readonly components: ReadonlyArray<{ toJSON(): unknown }>;
}): string {
  return textFromNodes(message.components.map((component) => component.toJSON()));
}

function textFromNodes(nodes: readonly unknown[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (typeof node.content === "string") lines.push(node.content);
    if (Array.isArray(node.components)) lines.push(textFromNodes(node.components));
  }
  return lines.filter((line) => line.length > 0).join("\n");
}

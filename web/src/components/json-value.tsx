import { collapseAllNested, darkStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { Code, Paper, ScrollArea } from "@mantine/core";

import { isJsonContainer, stringify } from "../lib/format";

interface JsonValueProps {
  value: unknown;
}

export function JsonValue({ value }: JsonValueProps) {
  if (!isJsonContainer(value)) {
    return <Code block>{stringify(value)}</Code>;
  }

  return (
    <ScrollArea type="auto">
      <Paper withBorder p="sm" radius="sm">
        <JsonView
          aria-label="JSON データ"
          compactTopLevel
          data={value}
          shouldExpandNode={collapseAllNested}
          style={darkStyles}
        />
      </Paper>
    </ScrollArea>
  );
}

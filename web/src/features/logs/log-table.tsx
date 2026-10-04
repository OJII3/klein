import { Fragment } from "react";
import { Badge, Code, Table, Text } from "@mantine/core";

import type { PinoLog } from "../../api";
import { formatTimestamp, levelLabel } from "../../lib/format";
import { LogDetails } from "./log-details";

interface LogTableProps {
  logs: PinoLog[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

function levelColor(level: number | string): string {
  switch (levelLabel(level).toLowerCase()) {
    case "trace":
    case "debug":
      return "gray";
    case "info":
      return "blue";
    case "warn":
      return "yellow";
    case "error":
    case "fatal":
      return "red";
    default:
      return "gray";
  }
}

export function LogTable({ logs, expandedId, onToggle }: LogTableProps) {
  return (
    <Table.ScrollContainer minWidth={800}>
      <Table highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>時刻</Table.Th>
            <Table.Th>レベル</Table.Th>
            <Table.Th>イベント</Table.Th>
            <Table.Th>概要</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {logs.map((log) => {
            const isExpanded = expandedId === log.id;
            return (
              <Fragment key={log.id}>
                <Table.Tr
                  aria-expanded={isExpanded}
                  aria-label={`${log.kind}: ${log.summary}`}
                  onClick={() => onToggle(log.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onToggle(log.id);
                    }
                  }}
                  role="button"
                  style={{ cursor: "pointer" }}
                  tabIndex={0}
                >
                  <Table.Td>
                    <Text size="sm" component="time" dateTime={log.timestamp}>
                      {formatTimestamp(log.timestamp)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={levelColor(log.level)} variant="light">
                      {levelLabel(log.level)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Code>{log.kind}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={2}>
                      {log.summary}
                    </Text>
                  </Table.Td>
                </Table.Tr>
                {isExpanded && (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <LogDetails log={log} />
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

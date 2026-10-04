import type { PinoLog } from "../../api";
import { JsonValue } from "../../components/json-value";
import { levelLabel } from "../../lib/format";

export function LogDetails({ log }: { log: PinoLog }) {
  const attributes = Object.keys(log.attributes ?? {}).length > 0 ? log.attributes : null;

  return (
    <Stack gap="sm" p="md">
      <Group gap="xl">
        <Text size="sm">
          ID <Code>{log.id}</Code>
        </Text>
        <Text size="sm">
          レベル <Text span>{levelLabel(log.level)}</Text>
        </Text>
      </Group>
      {attributes ? (
        <JsonValue value={attributes} />
      ) : (
        <Text size="sm" c="dimmed">
          属性はありません
        </Text>
      )}
    </Stack>
  );
}
import { Code, Group, Stack, Text } from "@mantine/core";

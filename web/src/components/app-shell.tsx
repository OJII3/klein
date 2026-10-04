import type { ReactNode } from "react";
import {
  ActionIcon,
  Container,
  Group,
  SegmentedControl,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";

import { formatTimestamp } from "../lib/format";

export type View = "logs" | "sessions" | "memory";

interface AppShellProps {
  view: View;
  lastUpdated: Date | null;
  onViewChange: (view: View) => void;
  onRefresh: () => void;
  children: ReactNode;
}

export function AppShell({ view, lastUpdated, onViewChange, onRefresh, children }: AppShellProps) {
  return (
    <Container size={1440} py="xl">
      <Stack gap="lg">
        <Group component="header" justify="space-between" align="center">
          <Group gap="sm">
            <ThemeIcon size={42} radius="md" variant="light" color="teal" aria-hidden="true">
              ◒
            </ThemeIcon>
            <Title order={1} size="h3">
              KLEIN OBSERVATORY
            </Title>
          </Group>
          <Group gap="sm">
            <Text size="xs" c="dimmed">
              ● ローカル接続
            </Text>
            {lastUpdated && (
              <time dateTime={lastUpdated.toISOString()}>
                更新 {formatTimestamp(lastUpdated.toISOString())}
              </time>
            )}
            <ActionIcon
              aria-label="再読み込み"
              variant="light"
              color="teal"
              onClick={onRefresh}
              type="button"
            >
              ↻
            </ActionIcon>
          </Group>
        </Group>

        <SegmentedControl
          aria-label="表示切り替え"
          value={view}
          onChange={(value) => onViewChange(value as View)}
          data={[
            { value: "logs", label: "▤ ログ" },
            { value: "sessions", label: "◌ Piセッション" },
            { value: "memory", label: "▣ メモリ" },
          ]}
        />

        <main>{children}</main>

        <Text component="footer" size="xs" c="dimmed" ta="center">
          Klein / local viewer
        </Text>
      </Stack>
    </Container>
  );
}

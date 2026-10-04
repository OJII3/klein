import { useEffect, useState, type SubmitEvent } from "react";
import { Button, Grid, Group, Paper, Select, Stack, Text, TextInput, Title } from "@mantine/core";

import type { LogsQuery, PinoLog } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { LEVEL_OPTIONS } from "../../lib/format";
import { LogTable } from "./log-table";

interface LogsViewProps {
  logs: PinoLog[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  filters: LogsQuery;
  onFilter: (query: LogsQuery) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

interface LogFilterDraft {
  level: string;
  q: string;
  channelId: string;
  event: string;
}

function draftFromFilters(filters: LogsQuery): LogFilterDraft {
  return {
    level: filters.level ?? "",
    q: filters.q ?? "",
    channelId: filters.channelId ?? "",
    event: filters.event ?? "",
  };
}

export function LogsView({
  logs,
  loading,
  loadingMore,
  error,
  nextCursor,
  filters,
  onFilter,
  onRetry,
  onLoadMore,
}: LogsViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => draftFromFilters(filters));

  useEffect(() => setDraft(draftFromFilters(filters)), [filters]);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    onFilter({
      limit: 100,
      ...(draft.level ? { level: draft.level } : {}),
      ...(draft.q ? { q: draft.q } : {}),
      ...(draft.channelId ? { channelId: draft.channelId } : {}),
      ...(draft.event ? { event: draft.event } : {}),
    });
  };

  const clear = () => {
    setDraft({ level: "", q: "", channelId: "", event: "" });
    onFilter({ limit: 100 });
  };

  return (
    <Stack component="section" gap="md" aria-labelledby="logs-heading">
      <Group justify="space-between" align="end">
        <Stack gap={0}>
          <Text size="xs" c="teal">
            PINO / JSONL
          </Text>
          <Title order={2} id="logs-heading">
            アプリケーションログ
          </Title>
        </Stack>
        <Text size="sm" c="dimmed">
          {logs.length.toLocaleString("ja-JP")} 件
        </Text>
      </Group>

      <Paper component="form" onSubmit={submit} withBorder p="md" radius="md">
        <Grid align="end">
          <Grid.Col span={{ base: 12, sm: 3 }}>
            <Select
              label="レベル"
              aria-label="ログレベル"
              data={LEVEL_OPTIONS}
              clearable
              placeholder="すべて"
              onChange={(level) => setDraft((current) => ({ ...current, level: level ?? "" }))}
              value={draft.level || null}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 3 }}>
            <TextInput
              label="検索"
              aria-label="ログを検索"
              onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
              placeholder="概要、イベント名…"
              value={draft.q}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 2 }}>
            <TextInput
              label="チャンネル"
              aria-label="チャンネルID"
              onChange={(event) =>
                setDraft((current) => ({ ...current, channelId: event.target.value }))
              }
              placeholder="channel ID"
              value={draft.channelId}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 2 }}>
            <TextInput
              label="イベント"
              aria-label="イベント名"
              onChange={(event) =>
                setDraft((current) => ({ ...current, event: event.target.value }))
              }
              placeholder="event"
              value={draft.event}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 2 }}>
            <Group justify="flex-end">
              <Button color="teal" type="submit">
                絞り込む
              </Button>
              <Button variant="subtle" color="gray" onClick={clear} type="button">
                クリア
              </Button>
            </Group>
          </Grid.Col>
        </Grid>
      </Paper>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && logs.length === 0 ? (
        <LoadingState />
      ) : logs.length === 0 ? (
        <EmptyState>条件に一致するログはありません</EmptyState>
      ) : (
        <Paper withBorder radius="md" p={0}>
          <LogTable
            expandedId={expandedId}
            logs={logs}
            onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          />
          <Group justify="center" p="md">
            {nextCursor ? (
              <Button
                variant="light"
                color="teal"
                disabled={loadingMore}
                onClick={onLoadMore}
                type="button"
              >
                {loadingMore ? "読み込み中…" : "次のログを読み込む"}
              </Button>
            ) : (
              <Text size="sm" c="dimmed">
                これより古いログはありません
              </Text>
            )}
          </Group>
        </Paper>
      )}
    </Stack>
  );
}

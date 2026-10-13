import type { PiSessionEvent, SessionSummary } from "../../api";
import {
  Button,
  Card,
  Grid,
  Group,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { formatShortTimestamp, truncateMiddle } from "../../lib/format";
import { SessionTimeline } from "./session-timeline";

interface SessionsViewProps {
  sessions: SessionSummary[];
  sessionsNextCursor: string | null;
  selectedSession: SessionSummary | null;
  events: PiSessionEvent[];
  nextCursor: string | null;
  loading: boolean;
  loadingMoreSessions: boolean;
  loadingDetail: boolean;
  loadingMoreDetail: boolean;
  error: string | null;
  detailError: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onLoadMoreSessions: () => void;
  onRetryDetail: () => void;
  onLoadMoreDetail: () => void;
}

export function SessionsView({
  sessions,
  sessionsNextCursor,
  selectedSession,
  events,
  nextCursor,
  loading,
  loadingMoreSessions,
  loadingDetail,
  loadingMoreDetail,
  error,
  detailError,
  onSelect,
  onRetry,
  onLoadMoreSessions,
  onRetryDetail,
  onLoadMoreDetail,
}: SessionsViewProps) {
  const selectableSessions = [
    ...(selectedSession && !sessions.some((session) => session.id === selectedSession.id)
      ? [selectedSession]
      : []),
    ...sessions,
  ];
  const sessionsById = new Map(selectableSessions.map((session) => [session.id, session] as const));

  return (
    <Stack component="section" gap="md" aria-labelledby="sessions-heading">
      <Group justify="space-between" align="end">
        <Stack gap={0}>
          <Text size="xs" c="teal">
            PI / SESSION JSONL
          </Text>
          <Title order={2} id="sessions-heading">
            Piセッション
          </Title>
        </Stack>
        <Text size="sm" c="dimmed">
          {sessions.length.toLocaleString("ja-JP")} 件
        </Text>
      </Group>
      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && sessions.length === 0 ? (
        <LoadingState />
      ) : sessions.length === 0 ? (
        <EmptyState>セッションがまだありません</EmptyState>
      ) : (
        <Grid>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Select
              hiddenFrom="md"
              label="セッション"
              placeholder="セッションを選択"
              searchable
              maxDropdownHeight={300}
              data={selectableSessions.map((session) => ({
                value: session.id,
                label: `${truncateMiddle(session.channelKey, 24)} · ${formatShortTimestamp(session.modified)}`,
              }))}
              filter={({ options, search, limit }) =>
                options
                  .filter((option) => {
                    if ("group" in option) return false;
                    const session = sessionsById.get(option.value);
                    const searchableText = `${session?.channelKey ?? option.label} ${session?.id ?? ""}`;
                    return searchableText.toLocaleLowerCase().includes(search.toLocaleLowerCase());
                  })
                  .slice(0, limit)
              }
              renderOption={({ option }) => {
                const session = sessionsById.get(option.value);
                if (!session) return option.label;

                return (
                  <Stack gap={2} w="100%" title={session.channelKey}>
                    <Text size="sm" fw={600} lineClamp={1}>
                      {truncateMiddle(session.channelKey, 36)}
                    </Text>
                    <Group justify="space-between" gap="xs">
                      <Text size="xs" c="dimmed">
                        更新 {formatShortTimestamp(session.modified)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {session.messageCount}件
                      </Text>
                    </Group>
                  </Stack>
                );
              }}
              value={selectedSession?.id ?? null}
              title={selectedSession?.channelKey}
              onChange={(id) => {
                if (id) onSelect(id);
              }}
            />
            <Paper visibleFrom="md" withBorder radius="md" p="xs">
              <ScrollArea.Autosize mah={560} type="auto">
                <Stack gap="xs" aria-label="セッション一覧">
                  {sessions.map((session) => {
                    const selected = selectedSession?.id === session.id;
                    return (
                      <Card
                        key={session.id}
                        component="button"
                        withBorder
                        p="sm"
                        bg={selected ? "teal.9" : undefined}
                        onClick={() => onSelect(session.id)}
                      >
                        <Stack gap={4} w="100%" align="stretch">
                          <Group justify="space-between" wrap="nowrap">
                            <Text
                              size="sm"
                              fw={600}
                              title={session.channelKey}
                              style={{
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {truncateMiddle(session.channelKey, 36)}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {session.messageCount}件
                            </Text>
                          </Group>
                          <Text size="xs" c="dimmed" ta="left">
                            更新 {formatShortTimestamp(session.modified)}
                          </Text>
                        </Stack>
                      </Card>
                    );
                  })}
                </Stack>
              </ScrollArea.Autosize>
              <Group justify="center" pt="sm">
                {sessionsNextCursor ? (
                  <Button
                    variant="light"
                    color="teal"
                    disabled={loadingMoreSessions}
                    onClick={onLoadMoreSessions}
                  >
                    {loadingMoreSessions ? "読み込み中…" : "古いセッションを読み込む"}
                  </Button>
                ) : (
                  <Text size="xs" c="dimmed">
                    これより古いセッションはありません
                  </Text>
                )}
              </Group>
            </Paper>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Stack>
              {detailError && <ErrorNotice message={detailError} onRetry={onRetryDetail} />}
              {loadingDetail ? (
                <LoadingState label="セッションを読み込み中…" />
              ) : selectedSession ? (
                <SessionTimeline
                  events={events}
                  loadingMore={loadingMoreDetail}
                  nextCursor={nextCursor}
                  onLoadMore={onLoadMoreDetail}
                  session={selectedSession}
                />
              ) : (
                <EmptyState>セッションを選択してください</EmptyState>
              )}
            </Stack>
          </Grid.Col>
        </Grid>
      )}
    </Stack>
  );
}

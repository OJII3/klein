import type { PiSessionEvent, SessionSummary } from "../../api";
import {
  Badge,
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
import { formatTimestamp } from "../../lib/format";
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
              data={[
                ...(selectedSession &&
                !sessions.some((session) => session.id === selectedSession.id)
                  ? [selectedSession]
                  : []),
                ...sessions,
              ].map((session) => ({
                value: session.id,
                label: `${session.channelKey} · ${session.firstMessage || "（メッセージなし）"}`,
              }))}
              value={selectedSession?.id ?? null}
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
                          <Group justify="space-between">
                            <Badge variant="light">{session.channelKey}</Badge>
                            <Text size="xs" c="dimmed">
                              {session.messageCount} msg
                            </Text>
                          </Group>
                          <Text size="sm" fw={600} lineClamp={2} ta="left">
                            {session.firstMessage || "（メッセージなし）"}
                          </Text>
                          <Text size="xs" c="dimmed" ta="left">
                            更新 {formatTimestamp(session.modified)}
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

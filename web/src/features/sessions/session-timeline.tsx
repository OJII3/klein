import type { PiSessionEvent, SessionSummary } from "../../api";
import { Badge, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { EmptyState } from "../../components/feedback";
import { JsonValue } from "../../components/json-value";
import { formatShortTimestamp, formatTimestamp, truncateMiddle } from "../../lib/format";

interface SessionTimelineProps {
  events: PiSessionEvent[];
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore: () => void;
  session: SessionSummary;
}

export function SessionTimeline({
  events,
  loadingMore,
  nextCursor,
  onLoadMore,
  session,
}: SessionTimelineProps) {
  return (
    <Paper withBorder radius="md" p="md">
      <Stack>
        <Group justify="space-between" align="start">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Title
              order={3}
              size="h4"
              title={session.channelKey}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {truncateMiddle(session.channelKey, 48)}
            </Title>
            <Text size="xs" c="dimmed">
              更新 {formatShortTimestamp(session.modified)}
            </Text>
          </Stack>
          <Stack gap={2} align="end">
            <Text size="sm">{session.messageCount} メッセージ</Text>
            <Text size="xs" c="dimmed">
              開始 {formatTimestamp(session.created)}
            </Text>
          </Stack>
        </Group>
        {events.length === 0 ? (
          <EmptyState>イベントがありません</EmptyState>
        ) : (
          <Stack gap="md">
            {events.map((event) => (
              <Stack key={event.id} gap="xs">
                <Group gap="xs">
                  <Badge size="sm" variant="light">
                    {event.kind}
                  </Badge>
                  {event.role && (
                    <Badge size="sm" color="gray" variant="outline">
                      {event.role}
                    </Badge>
                  )}
                  <Text size="xs" c="dimmed">
                    {formatTimestamp(event.timestamp)}
                  </Text>
                </Group>
                {event.errorMessage && (
                  <Paper withBorder p="sm" c="red" role="alert">
                    {event.errorMessage}
                  </Paper>
                )}
                {event.content !== undefined &&
                  (!Array.isArray(event.content) || event.content.length > 0) && (
                    <JsonValue value={event.content} />
                  )}
                {event.parentId && (
                  <Text size="xs" c="dimmed">
                    parent: {event.parentId}
                  </Text>
                )}
              </Stack>
            ))}
          </Stack>
        )}
        {events.length > 0 && (
          <Group justify="center">
            {nextCursor ? (
              <Button variant="light" color="teal" disabled={loadingMore} onClick={onLoadMore}>
                {loadingMore ? "読み込み中…" : "古いイベントを読み込む"}
              </Button>
            ) : (
              <Text size="sm" c="dimmed">
                これより古いイベントはありません
              </Text>
            )}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

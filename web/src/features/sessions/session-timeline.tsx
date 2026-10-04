import type { PiSessionEvent, SessionSummary } from "../../api";
import { Badge, Button, Group, Paper, Stack, Text, Timeline, Title } from "@mantine/core";
import { EmptyState } from "../../components/feedback";
import { JsonValue } from "../../components/json-value";
import { formatTimestamp } from "../../lib/format";

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
          <Stack gap={4}>
            <Badge variant="light" color="teal">
              {session.channelKey}
            </Badge>
            <Title order={3} size="h4">
              {session.firstMessage || "Pi session"}
            </Title>
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
          <Timeline active={events.length} bulletSize={24} lineWidth={2}>
            {events.map((event) => (
              <Timeline.Item
                key={event.id}
                title={
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
                }
              >
                <Stack mt="xs" gap="xs">
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
              </Timeline.Item>
            ))}
          </Timeline>
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

import { Alert, Button, Center, Loader, Stack, Text } from "@mantine/core";

interface ErrorNoticeProps {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}

export function ErrorNotice({ message, onRetry, retryLabel = "再試行" }: ErrorNoticeProps) {
  return (
    <Alert color="red" className="notice notice-error" role="alert" icon={null}>
      <div className="feedback-row">
        <span>{message}</span>
        <Button size="xs" variant="light" color="red" onClick={onRetry} type="button">
          {retryLabel}
        </Button>
      </div>
    </Alert>
  );
}

export function EmptyState({ children }: { children: string }) {
  return (
    <Center className="empty-state">
      <Text c="dimmed">{children}</Text>
    </Center>
  );
}

export function LoadingState({ label = "読み込み中…" }: { label?: string }) {
  return (
    <Center className="loading-state" role="status">
      <Stack align="center" gap="xs">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          {label}
        </Text>
      </Stack>
    </Center>
  );
}

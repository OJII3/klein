import { Alert, Button, Center, Loader, Stack, Text } from "@mantine/core";

interface ErrorNoticeProps {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}

export function ErrorNotice({ message, onRetry, retryLabel = "再試行" }: ErrorNoticeProps) {
  return (
    <Alert color="red" role="alert" icon={null}>
      <Stack gap="sm">
        <Text size="sm">{message}</Text>
        <Button size="xs" variant="light" color="red" onClick={onRetry} type="button">
          {retryLabel}
        </Button>
      </Stack>
    </Alert>
  );
}

export function EmptyState({ children }: { children: string }) {
  return (
    <Center mih={100} p="xl">
      <Text c="dimmed">{children}</Text>
    </Center>
  );
}

export function LoadingState({ label = "読み込み中…" }: { label?: string }) {
  return (
    <Center mih={100} p="xl" role="status">
      <Stack align="center" gap="xs">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          {label}
        </Text>
      </Stack>
    </Center>
  );
}

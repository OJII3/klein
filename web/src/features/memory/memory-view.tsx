import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Code,
  Divider,
  Grid,
  Group,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";

import type { MemoryEntry, MemoryGuildSummary } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { formatTimestamp } from "../../lib/format";

interface MemoryViewProps {
  enabled: boolean;
  guilds: MemoryGuildSummary[];
  selectedGuildId: string | null;
  entries: MemoryEntry[];
  loading: boolean;
  loadingDetail: boolean;
  error: string | null;
  detailError: string | null;
  deleteError: string | null;
  deletingEntryId: string | null;
  addingRule: boolean;
  addRuleError: string | null;
  onSelect: (guildId: string) => void;
  onDelete: (entryId: string) => void;
  onAddRule: (title: string, content: string) => void;
  onDismissDeleteError: () => void;
  onRetry: () => void;
  onRetryDetail: () => void;
}

export function MemoryView(props: MemoryViewProps) {
  const {
    enabled,
    guilds,
    selectedGuildId,
    entries,
    loading,
    loadingDetail,
    error,
    detailError,
    deleteError,
    deletingEntryId,
    addingRule,
    addRuleError,
    onSelect,
    onDelete,
    onAddRule,
    onDismissDeleteError,
    onRetry,
    onRetryDetail,
  } = props;

  return (
    <Stack component="section" gap="md" aria-labelledby="memory-heading">
      <Group justify="space-between" align="end">
        <Stack gap={0}>
          <Text size="xs" c="teal">
            PERSISTED GUILD CONTEXT
          </Text>
          <Title order={2} id="memory-heading">
            メモリ
          </Title>
        </Stack>
        <Text size="sm" c="dimmed">
          {guilds.length.toLocaleString("ja-JP")} ギルド
        </Text>
      </Group>
      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {!error && !enabled ? (
        <EmptyState>メモリ機能が無効です</EmptyState>
      ) : loading && guilds.length === 0 ? (
        <LoadingState />
      ) : guilds.length === 0 ? (
        <EmptyState>保存されたメモリがまだありません</EmptyState>
      ) : (
        <Grid>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Select
              hiddenFrom="md"
              label="ギルド"
              placeholder="ギルドを選択"
              searchable
              maxDropdownHeight={300}
              data={guilds.map((guild) => ({
                value: guild.guildId,
                label: `${guild.guildId} · ${guild.entryCount} 件`,
              }))}
              value={selectedGuildId}
              onChange={(guildId) => {
                if (guildId) onSelect(guildId);
              }}
            />
            <Paper visibleFrom="md" withBorder radius="md" p="xs">
              <ScrollArea.Autosize mah={360} type="auto">
                <Stack gap="xs" role="list" aria-label="ギルドメモリ一覧">
                  {guilds.map((guild) => {
                    const selected = selectedGuildId === guild.guildId;
                    return (
                      <Card
                        key={guild.guildId}
                        component="button"
                        withBorder
                        p="sm"
                        bg={selected ? "teal.9" : undefined}
                        onClick={() => onSelect(guild.guildId)}
                      >
                        <Stack gap={4} w="100%" align="stretch">
                          <Group justify="space-between">
                            <Badge variant="light">GUILD</Badge>
                            <Text size="xs" c="dimmed">
                              {guild.entryCount} 件
                            </Text>
                          </Group>
                          <Code>{guild.guildId}</Code>
                          <Text size="xs" c="dimmed" ta="left">
                            更新 {formatTimestamp(guild.updatedAt ?? undefined)}
                          </Text>
                        </Stack>
                      </Card>
                    );
                  })}
                </Stack>
              </ScrollArea.Autosize>
            </Paper>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Stack>
              {deleteError && (
                <ErrorNotice
                  message={deleteError}
                  onRetry={onDismissDeleteError}
                  retryLabel="閉じる"
                />
              )}
              {detailError && <ErrorNotice message={detailError} onRetry={onRetryDetail} />}
              {loadingDetail ? (
                <LoadingState label="メモリを読み込み中…" />
              ) : selectedGuildId ? (
                <MemoryEntries
                  deletingEntryId={deletingEntryId}
                  entries={entries}
                  guildId={selectedGuildId}
                  onDelete={onDelete}
                  addingRule={addingRule}
                  addRuleError={addRuleError}
                  onAddRule={onAddRule}
                />
              ) : (
                <EmptyState>ギルドを選択してください</EmptyState>
              )}
            </Stack>
          </Grid.Col>
        </Grid>
      )}
    </Stack>
  );
}

function MemoryEntries({
  deletingEntryId,
  entries,
  guildId,
  onDelete,
  addingRule,
  addRuleError,
  onAddRule,
}: {
  deletingEntryId: string | null;
  entries: MemoryEntry[];
  guildId: string;
  onDelete: (entryId: string) => void;
  addingRule: boolean;
  addRuleError: string | null;
  onAddRule: (title: string, content: string) => void;
}) {
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleContent, setRuleContent] = useState("");
  return (
    <Stack>
      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" mb="md">
          <Stack gap={0}>
            <Text size="xs" c="teal">
              GUILD ID
            </Text>
            <Code>{guildId}</Code>
          </Stack>
          <Text size="sm" c="dimmed">
            {entries.length.toLocaleString("ja-JP")} 件
          </Text>
        </Group>
        <Paper
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            const title = ruleTitle.trim();
            const content = ruleContent.trim();
            if (!title || !content) return;
            onAddRule(title, content);
            setRuleTitle("");
            setRuleContent("");
          }}
          withBorder
          p="md"
          radius="md"
        >
          <Stack>
            <Title order={3} size="h5">
              ルールを追加
            </Title>
            <TextInput
              label="タイトル"
              maxLength={200}
              value={ruleTitle}
              onChange={(event) => setRuleTitle(event.target.value)}
              required
            />
            <Textarea
              label="内容"
              maxLength={10000}
              minRows={3}
              value={ruleContent}
              onChange={(event) => setRuleContent(event.target.value)}
              required
            />
            {addRuleError && (
              <ErrorNotice
                message={addRuleError}
                onRetry={() => onAddRule(ruleTitle.trim(), ruleContent.trim())}
              />
            )}
            <Button
              w="fit-content"
              color="teal"
              disabled={addingRule || !ruleTitle.trim() || !ruleContent.trim()}
              type="submit"
            >
              {addingRule ? "追加中…" : "ルールを追加"}
            </Button>
          </Stack>
        </Paper>
      </Paper>
      {entries.length === 0 ? (
        <EmptyState>このギルドのメモリは空です</EmptyState>
      ) : (
        <ScrollArea.Autosize mah="70vh" type="auto">
          <Stack>
            {entries.map((entry) => (
              <Paper key={entry.id} withBorder radius="md" p="md">
                <Group justify="space-between" align="start" mb="sm">
                  <Stack gap="xs" align="start">
                    <Badge
                      variant="light"
                      color={
                        entry.kind === "rule" || entry.kind === "procedure"
                          ? "yellow"
                          : entry.kind === "decision"
                            ? "blue"
                            : "gray"
                      }
                    >
                      {entry.kind}
                    </Badge>
                    <Title order={3} size="h5">
                      {entry.title}
                    </Title>
                  </Stack>
                  <Group>
                    <Text size="xs" c="dimmed">
                      更新 {formatTimestamp(entry.updatedAt)}
                    </Text>
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      disabled={deletingEntryId !== null}
                      onClick={() => {
                        if (
                          window.confirm(
                            `「${entry.title}」を削除しますか？\nこの操作は元に戻せません。`,
                          )
                        )
                          onDelete(entry.id);
                      }}
                      type="button"
                    >
                      {deletingEntryId === entry.id ? "削除中…" : "削除"}
                    </Button>
                  </Group>
                </Group>
                <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {entry.content}
                </Text>
                <Divider my="sm" />
                <Group>
                  <Text size="xs" c="dimmed">
                    作成 {formatTimestamp(entry.createdAt)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    参照メッセージ {entry.sourceMessageIds.length.toLocaleString("ja-JP")} 件
                  </Text>
                </Group>
              </Paper>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </Stack>
  );
}

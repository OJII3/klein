import { useState } from "react";
import {
  Accordion,
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

import {
  memoryScopeKey,
  type MemoryEntry,
  type MemoryScope,
  type MemoryScopeSummary,
} from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { formatTimestamp } from "../../lib/format";

interface MemoryViewProps {
  enabled: boolean;
  scopes: MemoryScopeSummary[];
  selectedScope: MemoryScope | null;
  entries: MemoryEntry[];
  loading: boolean;
  loadingDetail: boolean;
  error: string | null;
  detailError: string | null;
  deleteError: string | null;
  deletingEntryId: string | null;
  addingRule: boolean;
  addRuleError: string | null;
  onSelect: (scope: MemoryScope) => void;
  onDelete: (entryId: string) => void;
  onAddRule: (title: string, content: string) => void;
  onDismissDeleteError: () => void;
  onRetry: () => void;
  onRetryDetail: () => void;
}

export function MemoryView(props: MemoryViewProps) {
  const {
    enabled,
    scopes,
    selectedScope,
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
            PERSISTED MEMORY CONTEXT
          </Text>
          <Title order={2} id="memory-heading">
            メモリ
          </Title>
        </Stack>
        <Text size="sm" c="dimmed">
          {scopes.length.toLocaleString("ja-JP")} スコープ
        </Text>
      </Group>
      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {!error && !enabled ? (
        <EmptyState>メモリ機能が無効です</EmptyState>
      ) : loading && scopes.length === 0 ? (
        <LoadingState />
      ) : scopes.length === 0 ? (
        <EmptyState>保存されたメモリがまだありません</EmptyState>
      ) : (
        <Grid>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Select
              hiddenFrom="md"
              label="スコープ"
              placeholder="スコープを選択"
              searchable
              maxDropdownHeight={300}
              data={scopes.map((summary) => ({
                value: memoryScopeKey(summary.scope),
                label: `${scopeName(summary.scope)} · ${summary.entryCount} 件`,
              }))}
              value={selectedScope ? memoryScopeKey(selectedScope) : null}
              onChange={(key) => {
                const summary = scopes.find((item) => memoryScopeKey(item.scope) === key);
                if (summary) onSelect(summary.scope);
              }}
            />
            <Paper visibleFrom="md" withBorder radius="md" p="xs">
              <ScrollArea.Autosize mah={360} type="auto">
                <Stack gap="xs" role="list" aria-label="メモリスコープ一覧">
                  {scopes.map((summary) => {
                    const selected =
                      selectedScope !== null &&
                      memoryScopeKey(selectedScope) === memoryScopeKey(summary.scope);
                    return (
                      <Card
                        key={memoryScopeKey(summary.scope)}
                        component="button"
                        withBorder
                        p="sm"
                        bg={selected ? "teal.9" : undefined}
                        onClick={() => onSelect(summary.scope)}
                      >
                        <Stack gap={4} w="100%" align="stretch">
                          <Group justify="space-between">
                            <Badge variant="light">
                              {summary.scope.type === "owner" ? "OWNER" : "GUILD"}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              {summary.entryCount} 件
                            </Text>
                          </Group>
                          <Code>{scopeName(summary.scope)}</Code>
                          <Text size="xs" c="dimmed" ta="left">
                            更新 {formatTimestamp(summary.updatedAt ?? undefined)}
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
              ) : selectedScope ? (
                <MemoryEntries
                  deletingEntryId={deletingEntryId}
                  entries={entries}
                  scope={selectedScope}
                  onDelete={onDelete}
                  addingRule={addingRule}
                  addRuleError={addRuleError}
                  onAddRule={onAddRule}
                />
              ) : (
                <EmptyState>スコープを選択してください</EmptyState>
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
  scope,
  onDelete,
  addingRule,
  addRuleError,
  onAddRule,
}: {
  deletingEntryId: string | null;
  entries: MemoryEntry[];
  scope: MemoryScope;
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
              {scope.type === "owner" ? "OWNER MEMORY" : "GUILD ID"}
            </Text>
            <Code>{scopeName(scope)}</Code>
          </Stack>
          <Text size="sm" c="dimmed">
            {entries.length.toLocaleString("ja-JP")} 件
          </Text>
        </Group>
        <Accordion defaultValue={null} variant="contained" radius="md" order={3}>
          <Accordion.Item value="add-rule">
            <Accordion.Control>ルールを追加</Accordion.Control>
            <Accordion.Panel>
              <Stack
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
              >
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
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Paper>
      {entries.length === 0 ? (
        <EmptyState>このスコープのメモリは空です</EmptyState>
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

function scopeName(scope: MemoryScope): string {
  return scope.type === "owner" ? "オーナー" : scope.guildId;
}

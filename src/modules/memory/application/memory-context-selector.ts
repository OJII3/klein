import type { MemoryDocument, MemoryEntry } from "../domain/memory";

const DEFAULT_MAX_RELATED_ENTRIES = 8;
const DEFAULT_MIN_RELATED_SCORE = 3;
const SEARCH_TOKEN_PATTERN =
  /[a-z0-9]+|[\p{Script=Han}]+|[\p{Script=Hiragana}]+|[\p{Script=Katakana}ー]+/giu;

export interface MemoryContextSelectionOptions {
  readonly maxRelatedEntries?: number;
  readonly minRelatedScore?: number;
}

export function selectMemoryEntries(
  document: MemoryDocument,
  query: string,
  options: MemoryContextSelectionOptions = {},
): MemoryDocument {
  const rules = document.entries.filter((entry) => entry.kind === "rule");
  const queryText = normalizeForSearch(query);
  const queryTerms = extractSearchTerms(queryText);
  const maxRelatedEntries = options.maxRelatedEntries ?? DEFAULT_MAX_RELATED_ENTRIES;
  const minRelatedScore = options.minRelatedScore ?? DEFAULT_MIN_RELATED_SCORE;

  const relatedEntries =
    queryTerms.length > 0
      ? document.entries
          .filter((entry) => entry.kind !== "rule")
          .map((entry, index) => ({
            entry,
            index,
            score: scoreMemoryEntry(entry, queryText, queryTerms),
          }))
          .filter(({ score }) => score >= minRelatedScore)
          .sort((left, right) => {
            const scoreDifference = right.score - left.score;
            if (scoreDifference !== 0) return scoreDifference;

            const updatedAtDifference = right.entry.updatedAt.localeCompare(left.entry.updatedAt);
            if (updatedAtDifference !== 0) return updatedAtDifference;

            return left.index - right.index;
          })
          .slice(0, maxRelatedEntries)
          .map(({ entry }) => entry)
      : [];

  return { entries: [...rules, ...relatedEntries] };
}

function scoreMemoryEntry(
  entry: MemoryEntry,
  queryText: string,
  queryTerms: readonly string[],
): number {
  const title = normalizeForSearch(entry.title);
  const content = normalizeForSearch(entry.content);
  let score = 0;

  if (queryText.length >= 2 && title.includes(queryText)) score += 8;
  if (queryText.length >= 2 && content.includes(queryText)) score += 6;

  for (const term of queryTerms) {
    if (title.includes(term)) score += term.length >= 3 ? 4 : 3;
    if (content.includes(term)) score += term.length >= 3 ? 2 : 1;
  }

  return score;
}

function extractSearchTerms(value: string): string[] {
  const terms = new Set<string>();
  const tokens = value.match(SEARCH_TOKEN_PATTERN) ?? [];

  for (const token of tokens) {
    const characters = Array.from(token);
    const isHanToken = /^[\p{Script=Han}]+$/u.test(token);
    if (characters.length >= 2 || isHanToken || /^\d+$/u.test(token)) {
      terms.add(token);
    }

    if (characters.length < 2 || !isJapaneseToken(token)) continue;
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.add(characters.slice(index, index + 2).join(""));
    }
  }

  return [...terms];
}

function normalizeForSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP").replace(/\s+/gu, " ").trim();
}

function isJapaneseToken(value: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(value);
}

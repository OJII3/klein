export const HANDOFF_SUMMARY_SYSTEM_PROMPT = `あなたはクラインの次セッション向け引き継ぎメモを作ります。
日本語で、ユーザーが次に話しかけられた時に必要な情報だけを短く残してください。
ユーザーの好み・継続中の話題・未解決の依頼や質問だけを最大5項目でまとめてください。
会話本文、引用、assistantの返信・説明・検索結果・送信文は引き継がないでください。
assistantが過去に述べた内容を、ユーザーが確認した事実や決定として扱わないでください。
Goalの文は呼び出し側で固定するため、出力には箇条書きだけを含めてください。
固有名詞、コード、識別子以外に日本語以外の言語を使わないでください。`;

export const HANDOFF_SUMMARY_MAX_TOKENS = 384;

export function buildHandoffSummaryPrompt(source: string, previousSummary?: string): string {
  return [
    "ユーザー発言と前回の要約を参考に、継続に必要な項目だけを箇条書きでまとめてください。",
    "各項目は短くし、全体を日本語で400字以内にしてください。引用や会話の再現は不要です。",
    previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>` : undefined,
    `<user-messages>\n${source || "（ユーザー発言なし）"}\n</user-messages>`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

export function extractTextContent(content: readonly unknown[]): string {
  return content
    .map((block) => {
      if (
        typeof block !== "object" ||
        block === null ||
        !("type" in block) ||
        block.type !== "text" ||
        !("text" in block)
      ) {
        return "";
      }
      return String(block.text);
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function formatHandoffSummary(summary: string): string {
  const bullets = summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s*/.test(line))
    .map((line) => `- ${line.replace(/^[-*•]\s*/, "").slice(0, 80)}`)
    .slice(0, 5);

  return [
    "## Goal",
    "クラインとして振る舞う",
    "",
    "## 引き継ぎ",
    ...(bullets.length > 0 ? bullets : ["- 継続事項なし"]),
  ].join("\n");
}

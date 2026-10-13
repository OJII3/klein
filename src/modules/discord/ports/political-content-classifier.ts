export type PoliticalContentClassification = "none" | "political" | "china-related" | "unknown";

export interface PoliticalContentClassifier {
  classify(text: string): Promise<PoliticalContentClassification>;
}

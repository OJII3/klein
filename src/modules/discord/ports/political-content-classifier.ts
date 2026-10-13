export interface PoliticalContentClassifier {
  containsPoliticalContent(text: string): Promise<boolean>;
}

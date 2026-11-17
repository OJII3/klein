export interface DiscordChoiceRequest {
  /** The question shown above the buttons. */
  readonly question: string;
  /** Button labels, in display order. */
  readonly options: readonly string[];
  /** The Discord user who may answer. */
  readonly requesterUserId: string;
}

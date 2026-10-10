export interface AsrRequest {
  write(pcm: Uint8Array): void;
  commit(): Promise<{ readonly text: string }>;
}

export interface AsrConnection {
  onError(handler: (error: Error) => void): () => void;
  start(options: { readonly requestId: string; readonly language: string }): AsrRequest;
  close(): void;
}

export interface AsrClient {
  connect(): Promise<AsrConnection>;
}

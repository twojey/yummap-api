export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface IPushProvider {
  send(tokens: string[], message: PushMessage): Promise<PushSendResult>;
}

export interface PushSendResult {
  successCount: number;
  failureCount: number;
  invalidTokens: string[];
}

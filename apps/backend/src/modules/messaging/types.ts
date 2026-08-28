import type { Channel, MessageStatus } from "@repo/domain";

export interface SendCaseMessageInput {
  tenantId: string;
  caseId?: string;
  customerId?: string;
  channel: Channel;
  templateId: string;
  variables: Record<string, string | number>;
  language?: string;
  step?: number;
  overrideIdempotencyKey?: string;
}

export interface SendCaseMessageResult {
  messageId: string;
  status: MessageStatus;
  idempotencyKey: string;
  channel: Channel;
  templateId: string;
  toAddress: string;
  providerMessageId?: string;
  isDuplicate?: boolean;
  sentAt?: Date;
  error?: string;
}

export interface ListMessagesQuery {
  case_id?: string;
  customer_id?: string;
  channel?: Channel;
  status?: MessageStatus;
  limit?: number;
  offset?: number;
}

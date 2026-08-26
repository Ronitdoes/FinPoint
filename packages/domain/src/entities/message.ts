import type { Channel } from "../enums/channel";
import type {
  MessageId,
  RecoveryCaseId,
  TenantId,
} from "../ids";

export interface Message {
  id: MessageId;
  tenantId: TenantId;
  caseId: RecoveryCaseId;
  channel: Channel;
  template: string;
  variables: Record<string, string | number>;
  language?: string;
  recipient?: string;
  providerMessageId?: string;
  sentAt?: string;
  deliveryError?: string;
  createdAt: string;
}

import type { Channel, MessageStatus, MessagingProvider as ProviderKind } from "@repo/domain";

/**
 * Standard input for sending a templated customer message (Spec 01 §14, s-19).
 */
export interface SendTemplateInput {
  tenantId: string;
  caseId?: string;
  customerId: string;
  channel: Channel;
  templateId: string;
  variables: Record<string, string | number>;
  toAddress: string;
  idempotencyKey: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Standard result returned by messaging adapters upon dispatch acceptance.
 */
export interface SendResult {
  providerMessageId: string;
  acceptedAt: Date;
  status: "SENT" | "QUEUED" | "FAILED" | "DELIVERED";
  rawResponse?: Record<string, unknown>;
  fee?: {
    amount: bigint;
    currency: string;
  };
}

/**
 * Standard Messaging Provider Interface (Spec 01 §14, Spec 03 §2, s-19).
 */
export interface MessagingProvider {
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  registerStatusWebhook?(url: string, secret?: string): Promise<void>;
}

/**
 * Template variable metadata definition.
 */
export interface TemplateVariableDefinition {
  name: string;
  type: "string" | "number" | "currency_amount" | "url" | "date";
  description?: string;
  required: boolean;
}

/**
 * Message template definition in registry.
 */
export interface MessageTemplate {
  id: string;
  channel: Channel;
  name: string;
  description: string;
  variables: string[];
  variableDefinitions?: TemplateVariableDefinition[];
  supportedLanguages: string[];
  defaultLanguage: string;
}

/**
 * Result of rendering a template for a given channel and language.
 */
export interface RenderedMessage {
  subject?: string;
  body: string;
  rawComponents?: Record<string, unknown>[];
}

/**
 * Template validation outcome.
 */
export interface TemplateValidationResult {
  valid: boolean;
  missingVariables: string[];
  unexpectedVariables: string[];
  error?: string;
}

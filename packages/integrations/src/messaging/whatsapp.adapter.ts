import type { MessagingProvider, SendResult, SendTemplateInput } from "./types";
import { assertValidTemplateVariables, renderTemplate } from "./templates/registry";

export interface WhatsAppAdapterOptions {
  apiKey?: string | null;
  phoneNumberId?: string | null;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class WhatsAppDeliveryError extends Error {
  readonly code = "WHATSAPP_DELIVERY_FAILED";
  readonly statusCode?: number;
  readonly rawError?: unknown;

  constructor(message: string, statusCode?: number, rawError?: unknown) {
    super(message);
    this.name = "WhatsAppDeliveryError";
    this.statusCode = statusCode;
    this.rawError = rawError;
  }
}

/**
 * WhatsApp Cloud API Messaging Adapter (Meta Graph API /v19.0/{phone_number_id}/messages).
 * Spec 01 §14, Spec 03 §1, s-19.
 */
export class WhatsAppAdapter implements MessagingProvider {
  private readonly apiKey: string;
  private readonly phoneNumberId: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: WhatsAppAdapterOptions = {}) {
    this.apiKey = options.apiKey || process.env.WHATSAPP_API_KEY || "mock_wa_key";
    this.phoneNumberId = options.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || "mock_wa_phone_id";
    this.baseUrl = options.baseUrl || "https://graph.facebook.com/v19.0";
    this.fetchFn = options.fetchFn || fetch;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /**
   * Sends a templated WhatsApp message via Meta Cloud API with 10s timeout and network retry x2.
   */
  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    // 1. Validate variables against closed template registry
    assertValidTemplateVariables(input.templateId, input.variables);

    // 2. Render template components
    const rendered = renderTemplate(
      input.templateId,
      "WHATSAPP",
      input.language || "en",
      input.variables,
    );

    const cleanTo = input.toAddress.replace(/[^\d+]/g, "").replace(/^\+/, "");
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: cleanTo,
      type: "template",
      template: {
        name: input.templateId,
        language: {
          code: input.language || "en",
        },
        components: rendered.rawComponents || [
          {
            type: "body",
            parameters: Object.entries(input.variables).map(([_, value]) => ({
              type: "text",
              text: String(value),
            })),
          },
        ],
      },
    };

    // 3. Network dispatch with retry (x2)
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await this.fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "X-Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const status = response.status;
          let bodyText: string;
          let parsed: any;
          try {
            bodyText = await response.text();
            parsed = JSON.parse(bodyText);
          } catch {
            bodyText = "Unable to parse error response";
            parsed = { raw: bodyText };
          }

          const errorMessage =
            parsed?.error?.message ||
            parsed?.error?.error_user_msg ||
            `WhatsApp Cloud API responded with HTTP ${status}: ${bodyText}`;

          const isNetworkOr5xx = status >= 500 || status === 429;
          if (isNetworkOr5xx && attempt < maxRetries) {
            const backoffMs = Math.min(100 * Math.pow(2, attempt) + Math.random() * 50, 1000);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }

          throw new WhatsAppDeliveryError(errorMessage, status, parsed);
        }

        const data: any = await response.json();
        const messageId = data?.messages?.[0]?.id || `wamid.${Date.now()}`;

        return {
          providerMessageId: messageId,
          acceptedAt: new Date(),
          status: "SENT",
          rawResponse: data,
        };
      } catch (err: any) {
        if (err instanceof WhatsAppDeliveryError) {
          throw err;
        }

        const isAbort = err.name === "AbortError" || err.code === "ABORT_ERR";
        const isNetworkErr =
          isAbort ||
          err.code === "ECONNRESET" ||
          err.code === "ETIMEDOUT" ||
          err.code === "ENOTFOUND" ||
          err.name === "FetchError" ||
          err.message?.includes("fetch failed");

        lastError = err;

        if (isNetworkErr && attempt < maxRetries) {
          const backoffMs = Math.min(100 * Math.pow(2, attempt) + Math.random() * 50, 1000);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        throw new WhatsAppDeliveryError(
          `WhatsApp dispatch failed: ${err.message || "Unknown error"}`,
          500,
          { originalError: err.message, name: err.name },
        );
      }
    }

    throw lastError || new WhatsAppDeliveryError("WhatsApp dispatch failed after retries", 500);
  }
}

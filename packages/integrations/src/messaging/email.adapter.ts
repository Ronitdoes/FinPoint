import type { MessagingConfig } from "@repo/config";
import type { MessagingProvider, SendResult, SendTemplateInput } from "./types";
import { assertValidTemplateVariables, renderTemplate } from "./templates/registry";

export interface EmailAdapterOptions {
  apiKey?: string | null;
  fromEmail?: string | null;
  /**
   * Preferred typed-config injection (CONVENTIONS §1: only `@repo/config`
   * reads `process.env`). The resolver (`resolveMessagingProvider`) forwards
   * the validated values; direct callers should pass credentials explicitly.
   */
  messagingConfig?: Partial<MessagingConfig> | null;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class EmailDeliveryError extends Error {
  readonly code = "EMAIL_DELIVERY_FAILED";
  readonly statusCode?: number;
  readonly rawError?: unknown;

  constructor(message: string, statusCode?: number, rawError?: unknown) {
    super(message);
    this.name = "EmailDeliveryError";
    this.statusCode = statusCode;
    this.rawError = rawError;
  }
}

/**
 * Transactional Email Messaging Adapter.
 * Spec 01 §14, Spec 03 §1, s-19.
 */
export class EmailAdapter implements MessagingProvider {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: EmailAdapterOptions = {}) {
    // CONVENTIONS §1: this package never reads `process.env` directly —
    // credentials arrive via explicit options or the injected typed
    // `messagingConfig` (type-only `@repo/config` import, so no runtime
    // cycle). The `mock_email_key` / `recovery@example.com` literals are a
    // grandfathered offline/test default of last resort, not live credentials
    // (live keys are fail-fast required by `@repo/config` when
    // MOCK_PROVIDERS=false).
    this.apiKey = options.apiKey || options.messagingConfig?.emailApiKey || "mock_email_key";
    this.fromEmail = options.fromEmail || options.messagingConfig?.emailFrom || "recovery@example.com";
    this.baseUrl = options.baseUrl || "https://api.resend.com/emails";
    this.fetchFn = options.fetchFn || fetch;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /**
   * Sends a templated Email with 10s timeout and network retry x2.
   */
  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    // 1. Validate variables against closed template registry
    assertValidTemplateVariables(input.templateId, input.variables);

    // 2. Render email subject and body
    const rendered = renderTemplate(
      input.templateId,
      "EMAIL",
      input.language || "en",
      input.variables,
    );

    const entityRefId = `${input.tenantId}:${input.caseId || "direct"}:${input.templateId}:${input.idempotencyKey}`;
    const payload = {
      from: this.fromEmail,
      to: [input.toAddress],
      subject: rendered.subject || "Notification from Recovery Service",
      html: rendered.body,
      text: rendered.body.replace(/<[^>]*>/g, ""),
      headers: {
        "X-Idempotency-Key": input.idempotencyKey,
        "X-Case-ID": input.caseId || "",
        "X-Tenant-ID": input.tenantId,
        "X-Entity-Ref-ID": entityRefId,
        "Message-ID": `<${input.idempotencyKey}@recovery.local>`,
        "List-Unsubscribe": `<mailto:unsubscribe@example.com?subject=unsubscribe:${input.tenantId}:${input.customerId}>, <https://example.com/unsubscribe?tenant=${encodeURIComponent(input.tenantId)}&customer=${encodeURIComponent(input.customerId)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };

    // 3. Network dispatch with retry (x2)
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await this.fetchFn(this.baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
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
            parsed?.message ||
            parsed?.error?.message ||
            `Email API responded with HTTP ${status}: ${bodyText}`;

          const isNetworkOr5xx = status >= 500 || status === 429;
          if (isNetworkOr5xx && attempt < maxRetries) {
            const backoffMs = Math.min(100 * Math.pow(2, attempt) + Math.random() * 50, 1000);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }

          throw new EmailDeliveryError(errorMessage, status, parsed);
        }

        const data: any = await response.json();
        const messageId = data?.id || `email_${Date.now()}`;

        return {
          providerMessageId: messageId,
          acceptedAt: new Date(),
          status: "SENT",
          rawResponse: data,
        };
      } catch (err: any) {
        if (err instanceof EmailDeliveryError) {
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

        throw new EmailDeliveryError(
          `Email dispatch failed: ${err.message || "Unknown error"}`,
          500,
          { originalError: err.message, name: err.name },
        );
      }
    }

    throw lastError || new EmailDeliveryError("Email dispatch failed after retries", 500);
  }
}

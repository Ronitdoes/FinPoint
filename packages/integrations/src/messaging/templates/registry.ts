import type { Channel } from "@repo/domain";
import type {
  MessageTemplate,
  RenderedMessage,
  TemplateValidationResult,
} from "../types";

import waPaymentRetryNotice from "./whatsapp/payment-retry-notice.json";
import waCartReminder from "./whatsapp/cart-reminder.json";
import waInvoiceReminder from "./whatsapp/invoice-reminder.json";
import waPtpConfirmation from "./whatsapp/ptp-confirmation.json";

// Raw JSON templates map for WhatsApp
const WHATSAPP_TEMPLATES: Record<string, any> = {
  payment_retry_notice: waPaymentRetryNotice,
  cart_reminder: waCartReminder,
  invoice_reminder: waInvoiceReminder,
  ptp_confirmation: waPtpConfirmation,
};

// Email subjects and body generators per template and language
const EMAIL_TEMPLATES: Record<
  string,
  {
    variables: string[];
    supportedLanguages: string[];
    defaultLanguage: string;
    subjects: Record<string, string>;
    bodies: Record<string, string>;
  }
> = {
  payment_retry_notice: {
    variables: ["customer_name", "amount", "currency", "payment_link", "due_date"],
    supportedLanguages: ["en", "es", "hi"],
    defaultLanguage: "en",
    subjects: {
      en: "Payment Retry Notice - Action Required",
      es: "Aviso de Pago - Acción Requerida",
      hi: "भुगतान सूचना - आवश्यक कार्रवाई",
    },
    bodies: {
      en: "Hello {{customer_name}}, your payment of {{currency}} {{amount}} was unsuccessful. Please update your payment method or pay here: {{payment_link}} before {{due_date}}.",
      es: "Hola {{customer_name}}, su pago de {{currency}} {{amount}} no se pudo procesar. Por favor actualice su método de pago o pague aquí: {{payment_link}} antes de {{due_date}}.",
      hi: "नमस्ते {{customer_name}}, आपका {{currency}} {{amount}} का भुगतान विफल रहा। कृपया {{due_date}} से पहले यहाँ भुगतान करें: {{payment_link}}।",
    },
  },
  cart_reminder: {
    variables: ["customer_name", "item_count", "total_amount", "currency", "checkout_url", "discount_code"],
    supportedLanguages: ["en", "es", "hi"],
    defaultLanguage: "en",
    subjects: {
      en: "Items waiting in your cart",
      es: "Artículos esperando en su carrito",
      hi: "आपकी कार्ट में आइटम प्रतीक्षा कर रहे हैं",
    },
    bodies: {
      en: "Hi {{customer_name}}, you left {{item_count}} items worth {{currency}} {{total_amount}} in your cart! Complete your order with code {{discount_code}}: {{checkout_url}}.",
      es: "Hola {{customer_name}}, dejó {{item_count}} artículos por {{currency}} {{total_amount}} en su carrito. Use el código {{discount_code}} en: {{checkout_url}}.",
      hi: "नमस्ते {{customer_name}}, आपकी कार्ट में {{currency}} {{total_amount}} मूल्य के {{item_count}} आइटम शेष हैं। कोड {{discount_code}} का उपयोग करें: {{checkout_url}}।",
    },
  },
  invoice_reminder: {
    variables: ["customer_name", "invoice_number", "amount_due", "currency", "due_date", "payment_url"],
    supportedLanguages: ["en", "es", "hi"],
    defaultLanguage: "en",
    subjects: {
      en: "Overdue Invoice Notice - Invoice #{{invoice_number}}",
      es: "Aviso de Factura Vencida - Factura #{{invoice_number}}",
      hi: "बकाया चालान सूचना - चालान #{{invoice_number}}",
    },
    bodies: {
      en: "Dear {{customer_name}}, Invoice #{{invoice_number}} for {{currency}} {{amount_due}} was due on {{due_date}}. Please view and pay: {{payment_url}}.",
      es: "Estimado/a {{customer_name}}, la factura #{{invoice_number}} por {{currency}} {{amount_due}} venció el {{due_date}}. Consulte y pague en: {{payment_url}}.",
      hi: "प्रिय {{customer_name}}, चालान #{{invoice_number}} (राशि: {{currency}} {{amount_due}}) की देय तिथि {{due_date}} थी। यहाँ भुगतान करें: {{payment_url}}।",
    },
  },
  ptp_confirmation: {
    variables: ["customer_name", "promised_amount", "currency", "promised_date", "payment_url"],
    supportedLanguages: ["en", "es", "hi"],
    defaultLanguage: "en",
    subjects: {
      en: "Confirmation: Promise to Pay Scheduled",
      es: "Confirmación: Compromiso de Pago Registrado",
      hi: "पुष्टि: भुगतान प्रतिबद्धता दर्ज की गई",
    },
    bodies: {
      en: "Dear {{customer_name}}, we confirmed your promise to pay {{currency}} {{promised_amount}} on {{promised_date}}. Pay anytime at: {{payment_url}}.",
      es: "Hola {{customer_name}}, confirmamos su compromiso de pago de {{currency}} {{promised_amount}} para el {{promised_date}}. Enlace: {{payment_url}}.",
      hi: "नमस्ते {{customer_name}}, हमने {{promised_date}} को {{currency}} {{promised_amount}} के भुगतान की आपकी प्रतिबद्धता दर्ज कर ली है। लिंक: {{payment_url}}।",
    },
  },
};

/**
 * Closed template definitions catalog.
 */
export const TEMPLATE_REGISTRY: Record<string, MessageTemplate> = {
  payment_retry_notice: {
    id: "payment_retry_notice",
    channel: "WHATSAPP",
    name: "Payment Retry Notice",
    description: "Notification to customer when a recurring or primary payment attempt fails",
    variables: ["customer_name", "amount", "currency", "payment_link", "due_date"],
    supportedLanguages: ["en", "es", "hi"],
    defaultLanguage: "en",
  },
  cart_reminder: {
    id: "cart_reminder",
    channel: "WHATSAPP",
    name: "Cart Abandonment Reminder",
    description: "Reminder with incentive for customers who left items in active checkout",
    variables: ["customer_name", "item_count", "total_amount", "currency", "checkout_url", "discount_code"],
    supportedLanguages: ["en", "es", "hi"],
    defaultLanguage: "en",
  },
  invoice_reminder: {
    id: "invoice_reminder",
    channel: "WHATSAPP",
    name: "Overdue Invoice Notice",
    description: "Reminder for unpaid and overdue commercial invoices",
    variables: ["customer_name", "invoice_number", "amount_due", "currency", "due_date", "payment_url"],
    supportedLanguages: ["en", "es", "hi"],
    defaultLanguage: "en",
  },
  ptp_confirmation: {
    id: "ptp_confirmation",
    channel: "WHATSAPP",
    name: "Promise to Pay Confirmation",
    description: "Receipt and timeline confirmation for customer promise to pay",
    variables: ["customer_name", "promised_amount", "currency", "promised_date", "payment_url"],
    supportedLanguages: ["en", "es", "hi"],
    defaultLanguage: "en",
  },
};

export class TemplateNotFoundError extends Error {
  readonly code = "TEMPLATE_NOT_FOUND";
  constructor(templateId: string) {
    super(`Template '${templateId}' not found in messaging registry`);
    this.name = "TemplateNotFoundError";
  }
}

export class InvalidTemplateVariablesError extends Error {
  readonly code = "INVALID_TEMPLATE_VARIABLES";
  readonly missingVariables: string[];
  readonly unexpectedVariables: string[];

  constructor(templateId: string, missing: string[], unexpected: string[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required variables: [${missing.join(", ")}]`);
    if (unexpected.length > 0) parts.push(`unexpected variables not in allowlist: [${unexpected.join(", ")}]`);
    super(`Invalid variables for template '${templateId}': ${parts.join("; ")}`);
    this.name = "InvalidTemplateVariablesError";
    this.missingVariables = missing;
    this.unexpectedVariables = unexpected;
  }
}

/**
 * Gets template definition by ID.
 */
export function getTemplate(templateId: string): MessageTemplate | undefined {
  return TEMPLATE_REGISTRY[templateId];
}

/**
 * Lists all registered templates, optionally filtered by channel.
 */
export function listTemplates(channel?: Channel): MessageTemplate[] {
  const all = Object.values(TEMPLATE_REGISTRY);
  if (!channel) return all;
  return all;
}

/**
 * Validates variables against a template's strict allowlist (Spec 19 §Variable allowlist enforcement).
 * Rejects unexpected keys and ensures required keys are provided.
 */
export function validateTemplateVariables(
  templateId: string,
  variables: Record<string, unknown> = {},
): TemplateValidationResult {
  const template = getTemplate(templateId);
  if (!template) {
    return {
      valid: false,
      missingVariables: [],
      unexpectedVariables: [],
      error: `Template '${templateId}' is not registered`,
    };
  }

  const declared = new Set(template.variables);
  const provided = Object.keys(variables);

  const missingVariables = template.variables.filter(
    (k) => variables[k] === undefined || variables[k] === null || variables[k] === "",
  );
  const unexpectedVariables = provided.filter((k) => !declared.has(k));

  const valid = missingVariables.length === 0 && unexpectedVariables.length === 0;

  return {
    valid,
    missingVariables,
    unexpectedVariables,
    error: valid
      ? undefined
      : `Variables do not match allowlist: missing=[${missingVariables.join(", ")}], unexpected=[${unexpectedVariables.join(", ")}]`,
  };
}

/**
 * Asserts that template variables match the registry allowlist; throws InvalidTemplateVariablesError on mismatch.
 */
export function assertValidTemplateVariables(
  templateId: string,
  variables: Record<string, unknown> = {},
): void {
  const template = getTemplate(templateId);
  if (!template) {
    throw new TemplateNotFoundError(templateId);
  }

  const validation = validateTemplateVariables(templateId, variables);
  if (!validation.valid) {
    throw new InvalidTemplateVariablesError(
      templateId,
      validation.missingVariables,
      validation.unexpectedVariables,
    );
  }
}

/**
 * Replaces {{variable}} placeholders in template string with actual variable values.
 */
function interpolateString(
  templateStr: string,
  variables: Record<string, string | number> = {},
): string {
  return templateStr.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const val = variables[key];
    return val !== undefined && val !== null ? String(val) : `{{${key}}}`;
  });
}

/**
 * Renders a registered template for the specified channel and language.
 */
export function renderTemplate(
  templateId: string,
  channel: Channel,
  language = "en",
  variables: Record<string, string | number> = {},
): RenderedMessage {
  const template = getTemplate(templateId);
  if (!template) {
    throw new TemplateNotFoundError(templateId);
  }

  const lang = template.supportedLanguages.includes(language)
    ? language
    : template.defaultLanguage;

  if (channel === "WHATSAPP") {
    const waData = WHATSAPP_TEMPLATES[templateId];
    if (!waData) {
      throw new TemplateNotFoundError(templateId);
    }

    const localized = waData.templates?.[lang] || waData.templates?.[waData.default_language] || {};
    const body = interpolateString(localized.body || "", variables);
    const header = localized.header ? interpolateString(localized.header, variables) : undefined;
    const footer = localized.footer || undefined;

    const components: Record<string, unknown>[] = [];
    if (header) {
      components.push({ type: "header", text: header });
    }
    components.push({ type: "body", text: body });
    if (footer) {
      components.push({ type: "footer", text: footer });
    }

    return {
      body,
      rawComponents: components,
    };
  }

  // Channel === "EMAIL" or "SMS"
  const emailData = EMAIL_TEMPLATES[templateId];
  if (!emailData) {
    throw new TemplateNotFoundError(templateId);
  }

  const rawSubject = emailData.subjects[lang] || emailData.subjects[emailData.defaultLanguage] || "";
  const rawBody = emailData.bodies[lang] || emailData.bodies[emailData.defaultLanguage] || "";

  const subject = interpolateString(rawSubject, variables);
  const body = interpolateString(rawBody, variables);

  return {
    subject,
    body,
  };
}

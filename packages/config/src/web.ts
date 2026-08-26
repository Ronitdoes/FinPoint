import {
  ConfigValidationError,
  nodeEnvSchema,
  normalizeSource,
  webPublicSchema,
} from "./env";

export interface WebConfig {
  readonly env: "development" | "test" | "production";
  /** Base URL of the backend API consumed by the browser. */
  readonly publicApiUrl: string;
}

const webSchema = webPublicSchema.extend({
  NODE_ENV: nodeEnvSchema.default("development"),
});

/**
 * Typed, validated configuration for the frontend (`apps/frontend`).
 *
 * Only browser-safe values live here — no secrets ever cross this boundary
 * (CONVENTIONS §12). Frontend-only vars such as NEXT_PUBLIC_API_URL belong in
 * `.env.local` (gitignored); see `.env.example`.
 */
export function webConfig(
  source: Record<string, string | undefined> = process.env,
): WebConfig {
  const result = webSchema.safeParse(normalizeSource(source));
  if (!result.success) {
    throw new ConfigValidationError(
      "Invalid environment configuration:\n"
        + result.error.issues
          .map((issue) => `- ${issue.path.join(".") || "(env)"}: ${issue.message}`)
          .join("\n"),
    );
  }
  const raw = result.data;
  return Object.freeze({
    env: raw.NODE_ENV,
    publicApiUrl: raw.NEXT_PUBLIC_API_URL,
  });
}

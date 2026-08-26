# ADR-008 — LLM access: OpenAI-compatible client with schema-enforced structured outputs

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §10; `specs/02-architecture-and-domain.md` §2 (AI Decision Service), §6 (action catalog); `specs/03-mvp-build-spec.md` §5

## Context

The AI Decision Service must produce machine-checkable decisions (diagnosis + ranked actions + stop conditions) that downstream policy evaluation can trust. The system must remain provider-portable and must not expose arbitrary tool execution to the model (spec 00 §8: never `Event → LLM → arbitrary tools`).

## Decision

1. LLM access goes through an OpenAI-compatible chat-completions client with a configurable base URL, so any compatible provider/gateway works by changing env only.
2. The model is configured via `AI_MODEL`; credentials via `LLM_API_KEY` (see `.env.example`).
3. Every decision request uses **structured outputs enforced by JSON Schema**: the MVP decision schema (spec 03 §5) plus prompt-specific schemas live in `apps/backend/src/modules/ai/schemas/`.
4. No tool-calling, no arbitrary tools, no function-calling escape hatches. The model selects actions **only** from the closed Action Catalog (spec 02 §6).
5. Every model response passes: JSON-Schema structural validation → semantic validation → policy evaluation before any execution path can see it (recorded as governing principle in `docs/CONVENTIONS.md`).
6. Prompts are versioned artifacts under `apps/backend/src/modules/ai/prompts/` and recorded in audit entries (`prompt_version`, spec 01 §18).

## Consequences

- Provider swaps do not touch business code.
- Malformed model output fails closed at the validation boundary (handled in s-14/s-15).
- Cost tracking per call is captured for the cost model (spec 02 §8, implemented s-26).

## Alternatives considered

- **Provider SDKs directly (e.g., Anthropic SDK):** rejected; couples business logic to one vendor's API shape.
- **Agentic tool-calling loop:** rejected; violates bounded-autonomy principle (spec 00 §1/§8).

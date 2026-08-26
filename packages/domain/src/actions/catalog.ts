import { z } from "zod";

import { ACTION_TYPES, isActionType, type ActionType } from "../enums/action-type";
import { RISK_TYPES, type RiskType } from "../enums/risk-type";
import {
  HUMAN_TASK_PRIORITIES,
  type HumanTaskPriority,
} from "../enums/human-task-priority";
import { MAX_AUTO_DISCOUNT_MINOR } from "../policy/limits";

export const INCENTIVE_KINDS = ["DISCOUNT", "COUPON"] as const;
export type IncentiveKind = (typeof INCENTIVE_KINDS)[number];

export { HUMAN_TASK_PRIORITIES, type HumanTaskPriority };

const messageTypeSchema = z.object({
  template: z.string().min(1),
  variables: z.record(z.union([z.string(), z.number()])),
  language: z.string().min(1).optional(),
});

export const ACTION_PARAMETER_SCHEMAS = {
  RETRY_PAYMENT: z.object({
    attempt_number: z.number().int().min(1),
  }),
  CREATE_PAYMENT_LINK: z.object({
    amount_minor: z.number().int().positive(),
    currency: z.string().length(3),
    expires_in_hours: z.number().int().positive(),
  }),
  SEND_EMAIL: messageTypeSchema,
  SEND_WHATSAPP: messageTypeSchema,
  SEND_SMS: messageTypeSchema,
  OFFER_INCENTIVE: z.object({
    kind: z.enum(INCENTIVE_KINDS),
    amount_minor: z.number().int().positive().max(MAX_AUTO_DISCOUNT_MINOR),
  }),
  REQUEST_PAYMENT_METHOD_UPDATE: z.object({
    link_url: z.string().url().optional(),
  }),
  CREATE_PROMISE_TO_PAY: z.object({
    promised_amount_minor: z.number().int().positive(),
    promised_by_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  }),
  CREATE_HUMAN_TASK: z.object({
    task_type: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    priority: z.enum(HUMAN_TASK_PRIORITIES),
  }),
  PAUSE_CASE: z.object({
    reason: z.string().min(1),
  }),
  STOP_CASE: z.object({
    reason: z.string().min(1),
  }),
} as const satisfies Record<ActionType, z.ZodTypeAny>;

export type ActionParameterMap = {
  [T in ActionType]: z.infer<(typeof ACTION_PARAMETER_SCHEMAS)[T]>;
};

export function actionParameterSchema<T extends ActionType>(
  type: T,
): (typeof ACTION_PARAMETER_SCHEMAS)[T] {
  return ACTION_PARAMETER_SCHEMAS[type];
}

export class UnknownActionTypeError extends Error {
  readonly code = "UNKNOWN_ACTION_TYPE";

  constructor(type: string) {
    super(`Action type "${type}" is not in the closed action catalog`);
    this.name = "UnknownActionTypeError";
  }
}

export function validateActionParameters<T extends ActionType>(
  type: T,
  parameters: unknown,
): ActionParameterMap[T] {
  return ACTION_PARAMETER_SCHEMAS[type].parse(parameters) as ActionParameterMap[T];
}

export function tryValidateCatalogAction(
  type: string,
  parameters: unknown,
): CataloguedAction {
  if (!isActionType(type)) {
    throw new UnknownActionTypeError(type);
  }
  const parsed = ACTION_PARAMETER_SCHEMAS[type].parse(parameters) as
    ActionParameterMap[typeof type];
  return { ...parsed, type } as CataloguedAction;
}

export type CataloguedAction<T extends ActionType = ActionType> =
  ActionParameterMap[T] & { type: T };

const cataloguedEntries = ACTION_TYPES.map((type) =>
  (ACTION_PARAMETER_SCHEMAS[type] as z.ZodObject<z.ZodRawShape>).extend({
    type: z.literal(type),
  }),
);

export const cataloguedActionSchema = z.discriminatedUnion(
  "type",
  cataloguedEntries as unknown as [
    z.ZodDiscriminatedUnionOption<"type">,
    ...z.ZodDiscriminatedUnionOption<"type">[],
  ],
);

export const AI_DECIDABLE_ACTIONS: Readonly<
  Record<RiskType, readonly ActionType[]>
> = Object.freeze({
  PAYMENT_FAILURE: Object.freeze([
    "RETRY_PAYMENT",
    "CREATE_PAYMENT_LINK",
    "SEND_WHATSAPP",
    "SEND_EMAIL",
    "REQUEST_PAYMENT_METHOD_UPDATE",
    "CREATE_HUMAN_TASK",
    "STOP_CASE",
  ] satisfies readonly ActionType[]),
  CHECKOUT_ABANDONMENT: Object.freeze([
    "SEND_EMAIL",
    "SEND_WHATSAPP",
    "OFFER_INCENTIVE",
    "CREATE_HUMAN_TASK",
    "STOP_CASE",
  ] satisfies readonly ActionType[]),
  INVOICE_OVERDUE: Object.freeze([
    "SEND_EMAIL",
    "SEND_WHATSAPP",
    "CREATE_PAYMENT_LINK",
    "OFFER_INCENTIVE",
    "CREATE_PROMISE_TO_PAY",
    "CREATE_HUMAN_TASK",
    "STOP_CASE",
  ] satisfies readonly ActionType[]),
} satisfies Record<RiskType, readonly ActionType[]>);

export function aiDecidableActions(riskType: RiskType): readonly ActionType[] {
  return AI_DECIDABLE_ACTIONS[riskType];
}

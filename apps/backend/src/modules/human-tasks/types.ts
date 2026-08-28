import { z } from "zod";
import {
  HUMAN_TASK_PRIORITIES,
  HUMAN_TASK_STATUSES,
  HUMAN_TASK_TYPES,
  type HumanTaskPriority,
  type HumanTaskStatus,
  type HumanTaskType,
} from "@repo/domain";

export const listHumanTasksQuerySchema = z.object({
  status: z.enum(HUMAN_TASK_STATUSES).optional(),
  type: z.enum(HUMAN_TASK_TYPES).optional(),
  assigned_to: z.string().uuid().optional(),
  overdue: z
    .enum(["true", "false"])
    .transform((val) => val === "true")
    .or(z.boolean())
    .optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export type ListHumanTasksQuery = z.infer<typeof listHumanTasksQuerySchema>;

export const humanTaskParamsSchema = z.object({
  id: z.string().uuid("Invalid task ID format"),
});

export const createHumanTaskBodySchema = z.object({
  case_id: z.string().uuid("Invalid case ID format"),
  type: z.enum(HUMAN_TASK_TYPES),
  title: z.string().min(1, "Title is required").max(255, "Title exceeds 255 chars"),
  description: z.string().max(4000, "Description exceeds 4000 chars").optional(),
  priority: z.enum(HUMAN_TASK_PRIORITIES).default("MEDIUM"),
  sla_due_at: z
    .string()
    .datetime({ offset: true })
    .or(z.string().datetime())
    .optional(),
});

export type CreateHumanTaskBody = z.infer<typeof createHumanTaskBodySchema>;

export const approveHumanTaskBodySchema = z.object({
  notes: z.string().max(4000, "Notes exceed 4000 chars").optional(),
});

export type ApproveHumanTaskBody = z.infer<typeof approveHumanTaskBodySchema>;

export const rejectHumanTaskBodySchema = z.object({
  notes: z
    .string()
    .min(1, "Notes are required when rejecting a task")
    .max(4000, "Notes exceed 4000 chars"),
});

export type RejectHumanTaskBody = z.infer<typeof rejectHumanTaskBodySchema>;

export const assignHumanTaskBodySchema = z.object({
  assignee_user_id: z.string().uuid("Invalid user ID format").nullable().optional(),
});

export type AssignHumanTaskBody = z.infer<typeof assignHumanTaskBodySchema>;

export const cancelHumanTaskBodySchema = z.object({
  reason: z.string().max(4000, "Reason exceeds 4000 chars").optional(),
});

export type CancelHumanTaskBody = z.infer<typeof cancelHumanTaskBodySchema>;

export interface HumanTaskActorContext {
  userId?: string;
  role: string;
  actorType: "USER" | "SYSTEM" | "AI" | "WORKFLOW";
}

export interface HumanTaskSummaryResponse {
  id: string;
  tenantId: string;
  caseId: string;
  type: HumanTaskType;
  title: string;
  description: string | null;
  priority: HumanTaskPriority;
  status: HumanTaskStatus;
  assignedTo: string | null;
  slaDueAt: string | null;
  overdueAt: string | null;
  isOverdue: boolean;
  escalationCount: number;
  decidedBy: string | null;
  decisionNotes: string | null;
  decidedAt: string | null;
  temporalSignalSent: boolean;
  createdAt: string;
  updatedAt: string;
  case?: {
    id: string;
    caseNumber: number;
    customerId: string;
    status: string;
    amountAtRisk: string;
    currency: string;
    riskScore: number;
    riskType: string;
  };
}

export interface HumanTaskDetailResponse extends HumanTaskSummaryResponse {
  caseDetail?: Record<string, unknown>;
  decisionContext?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
}

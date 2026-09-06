import type {
  AnalyticsSummary,
  AuthMeResponse,
  CanonicalCaseDetail,
  CaseSummary,
  FunnelStage,
  HumanTask,
  InterventionStat,
  PolicyRule,
  PolicyVersion,
  RecoveryTimeseriesPoint,
  RiskEvaluationItem,
  RiskMixItem,
  TimelineItem,
  User,
  ApiKey,
  AuditLogItem,
  AiPerformanceMetrics,
  UserRole,
} from "./types";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

// Backend uses camelCase drizzle rows on several read endpoints while the
// frontend canonical types are snake_case. Normalizers below accept both
// shapes so the UI renders live data regardless of endpoint casing.
//
// All raw payloads are typed as `unknown` and narrowed via the helpers
// below — never `any` — so `no-explicit-any` stays clean.
type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** First defined (non-null/undefined) value among candidates. */
function pick<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** Field lookup across snake_case / camelCase aliases. */
function field(obj: JsonRecord, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function toStringMinor(value: unknown, fallback = "0"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): boolean {
  return !!value && UUID_RE.test(value.trim());
}

// Backend HumanTaskService returns camelCase summaries
// ({ tenantId, caseId, title, description, assignedTo, slaDueAt, ... })
// while the frontend canonical shape is snake_case with reason/notes.
// Normalize once here so tasks UI renders live data.
function normalizeHumanTask(value: unknown): HumanTask {
  const t = asRecord(value);
  return {
    id: strOr(t.id),
    tenant_id: strOr(field(t, "tenant_id", "tenantId")),
    case_id: strOr(field(t, "case_id", "caseId")),
    type: strOr(t.type),
    status: (t.status as HumanTask["status"]) ?? "PENDING",
    priority: (t.priority as HumanTask["priority"]) ?? "MEDIUM",
    assigned_to_user_id: (field(t, "assigned_to_user_id", "assignedTo") as string | null) ?? null,
    reason: strOr(field(t, "reason", "title", "type")),
    notes: (field(t, "notes", "description") as string | null) ?? null,
    resolution_notes:
      (field(t, "resolution_notes", "decisionNotes", "decision_notes") as string | null) ?? null,
    due_at: (field(t, "due_at", "slaDueAt", "sla_due_at") as string | null) ?? null,
    created_at: strOr(field(t, "created_at", "createdAt")),
    updated_at: strOr(field(t, "updated_at", "updatedAt")),
    case: t.case as HumanTask["case"],
  };
}

function normalizeRiskItem(value: unknown): RiskEvaluationItem {
  const r = asRecord(value);
  return {
    id: strOr(r.id),
    tenant_id: strOr(field(r, "tenant_id", "tenantId")),
    customer_id: strOr(field(r, "customer_id", "customerId")),
    case_id: field(r, "case_id", "caseId") as string | undefined,
    risk_type: field(r, "risk_type", "riskType") as RiskEvaluationItem["risk_type"],
    band: r.band as RiskEvaluationItem["band"],
    score: numOr(r.score),
    factors: asRecord(r.factors),
    status: strOr(r.status),
    computed_at: strOr(field(r, "computed_at", "computedAt")),
  };
}

function normalizeTimelineItem(value: unknown): TimelineItem {
  const e = asRecord(value);
  const actor = asRecord(e.actor);
  return {
    id: String(field(e, "id", "event_id") ?? Math.random().toString(36).slice(2)),
    event_type: strOr(field(e, "event_type", "eventType", "type"), "UNKNOWN"),
    timestamp: strOr(
      field(e, "timestamp", "at", "occurred_at", "created_at"),
      new Date().toISOString(),
    ),
    actor_type:
      (field(e, "actor_type", "actorType") as TimelineItem["actor_type"]) ??
      (strOr(actor.type) as TimelineItem["actor_type"]) ??
      "SYSTEM",
    actor_id:
      (field(e, "actor_id", "actorId") as string | null) ??
      (typeof actor.id === "string" ? actor.id : null),
    summary: strOr(field(e, "summary", "description")),
    metadata: asRecord(field(e, "metadata", "data", "payload")),
  };
}

function normalizeAuditItem(value: unknown): AuditLogItem {
  const l = asRecord(value);
  return {
    id: String(l.id ?? ""),
    tenant_id: strOr(field(l, "tenant_id", "tenantId")),
    case_id: (field(l, "case_id", "caseId") as string | null) ?? null,
    event: strOr(l.event),
    actor_type:
      (field(l, "actor_type", "actorType") as AuditLogItem["actor_type"]) ?? "SYSTEM",
    actor_id: (field(l, "actor_id", "actorId") as string | null) ?? null,
    metadata: asRecord(l.metadata),
    created_at: strOr(field(l, "created_at", "createdAt")),
  };
}

function normalizeApiKey(value: unknown): ApiKey {
  const k = asRecord(value);
  return {
    id: strOr(k.id),
    tenantId: strOr(field(k, "tenantId", "tenant_id")),
    name: strOr(k.name),
    keyPrefix: strOr(field(k, "keyPrefix", "prefix")),
    scopes: asArray(k.scopes).filter((s): s is string => typeof s === "string"),
    expiresAt: (field(k, "expiresAt", "expires_at") as string | null) ?? null,
    revokedAt: (field(k, "revokedAt", "revoked_at") as string | null) ?? null,
    lastUsedAt: (field(k, "lastUsedAt", "last_used_at") as string | null) ?? null,
    createdAt: strOr(field(k, "createdAt", "created_at")),
  };
}

function inferPolicyCategory(code: string): string {
  if (code.startsWith("POL-EM") || code.startsWith("POL-WA")) return "COMMUNICATION";
  if (code.includes("APPROVAL") || code.includes("HIGHVALUE")) return "APPROVAL";
  if (code.includes("DISCOUNT")) return "SPENDING";
  return "STOP_CONDITION";
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined | null>;
}

export async function apiClient<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { params, headers, ...customConfig } = options;

  let url = `${API_BASE_URL}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        searchParams.append(key, String(value));
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }

  const config: RequestInit = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    credentials: "include", // Transmit rr_session cookie
    ...customConfig,
  };

  const response = await fetch(url, config);

  if (response.status === 204) {
    return {} as T;
  }

  if (response.status === 401) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(401, "UNAUTHENTICATED", "Session expired or unauthorized");
  }

  let data: unknown;
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    data = await response.json().catch(() => ({}));
  } else {
    data = await response.text().catch(() => "");
  }

  if (!response.ok) {
    const errorEnvelope = asRecord(data);
    const nested = asRecord(errorEnvelope.error);
    const errCode =
      strOr(nested.code) || strOr(errorEnvelope.code) || "API_ERROR";
    const errMessage =
      strOr(nested.message) ||
      strOr(errorEnvelope.message) ||
      response.statusText ||
      "An error occurred";
    const errDetails = nested.details ?? errorEnvelope.details;
    throw new ApiError(response.status, errCode, errMessage, errDetails);
  }

  return data as T;
}

export const api = {
  // Auth
  auth: {
    login: (body: { email: string; password: string }) =>
      apiClient<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    logout: () => apiClient<void>("/auth/logout", { method: "POST" }),
    me: async (): Promise<AuthMeResponse> => {
      const res = await apiClient<{
        user?: { id: string; email: string; name: string; role: UserRole; tenantId: string; status: string };
        auth?: { kind: "session" | "api_key"; userId?: string; tenantId: string; role: UserRole; scopes?: string[] };
        userId?: string;
        tenantId?: string;
        role?: UserRole;
        email?: string;
        name?: string;
      }>("/auth/me");

      return {
        authenticated: true,
        userId: res.user?.id || res.auth?.userId || res.userId || "",
        tenantId: res.user?.tenantId || res.auth?.tenantId || res.tenantId || "",
        role: res.user?.role || res.auth?.role || res.role || "VIEWER",
        email: res.user?.email || res.email,
        name: res.user?.name || res.name,
        kind: res.auth?.kind || "session",
        scopes: res.auth?.scopes,
      };
    },
  },

  // Analytics
  analytics: {
    getSummary: async (params?: { from?: string; to?: string }): Promise<AnalyticsSummary> => {
      const raw = asRecord(await apiClient<unknown>("/analytics/summary", { params }));
      if (Object.keys(raw).length === 0) return raw as unknown as AnalyticsSummary;
      const financial = asRecord(raw.financial);
      const operational = asRecord(raw.operational);
      if (Object.keys(financial).length > 0 || Object.keys(operational).length > 0) {
        const recoveryRateBps = financial.recovery_rate_bps;
        return {
          revenueAtRisk: toStringMinor(financial.revenue_at_risk_minor),
          revenueRecovered: toStringMinor(financial.revenue_recovered_minor),
          recoveryRate:
            typeof recoveryRateBps === "number" ? recoveryRateBps / 100 : 0,
          recoveryCost:
            financial.recovery_cost_minor != null
              ? toStringMinor(financial.recovery_cost_minor)
              : null,
          netRecovered:
            financial.net_recovered_minor != null
              ? toStringMinor(financial.net_recovered_minor)
              : null,
          currency: strOr(financial.currency, "INR"),
          activeCases: numOr(operational.active_cases),
          escalatedCases: numOr(operational.escalations),
          // Backend summary has no per-outcome case counts; keep explicit zeros
          // rather than implying live recovered/stopped/failed breakdowns.
          recoveredCases: numOr(operational.recovered_cases),
          stoppedCases: numOr(operational.stopped_cases),
          failedCases: numOr(operational.failed_cases),
          timeRange: {
            from: params?.from ?? "",
            to: params?.to ?? "",
          },
        };
      }
      return raw as unknown as AnalyticsSummary;
    },
    getRecoveryTimeseries: async (params?: { from?: string; to?: string; bucket?: "day" | "week" }): Promise<{ points: RecoveryTimeseriesPoint[] }> => {
      const raw = asRecord(await apiClient<unknown>("/analytics/recovery", { params }));
      // Backend returns { bucket, timeseries: [{ date, at_risk_minor, recovered_minor }] }
      const rows = asArray(raw.points ?? raw.timeseries);
      const points = rows.map((row) => {
        const p = asRecord(row);
        return {
          bucket: strOr(p.bucket ?? p.date),
          revenueAtRisk: toStringMinor(p.revenueAtRisk ?? p.at_risk_minor),
          revenueRecovered: toStringMinor(p.revenueRecovered ?? p.recovered_minor),
          casesCount: numOr(p.casesCount),
          recoveredCasesCount: numOr(p.recoveredCasesCount),
        };
      });
      return { points };
    },
    getFunnel: async (params?: { from?: string; to?: string }): Promise<{ stages: FunnelStage[] }> => {
      const raw = asRecord(await apiClient<unknown>("/analytics/funnel", { params }));
      const rows = asArray(raw.stages);
      // Backend stages carry { stage, count, amount_minor } plus a top-level
      // conversion_rate_bps. Per-stage conversion is derived as
      // count[i] / count[i-1] so the funnel chart never renders flat 0%.
      const counts = rows.map((row) => numOr(asRecord(row).count));
      const stages: FunnelStage[] = rows.map((row, idx) => {
        const s = asRecord(row);
        const count = counts[idx] ?? 0;
        let conversionRate: number;
        const explicit =
          s.conversionRate ?? s.conversion_rate_bps;
        if (typeof explicit === "number") {
          conversionRate =
            s.conversionRate !== undefined ? explicit : explicit / 100;
        } else if (idx > 0) {
          const prevCount = counts[idx - 1] ?? 0;
          conversionRate = prevCount > 0 ? Math.round((count / prevCount) * 1000) / 10 : 0;
        } else {
          conversionRate = 100;
        }
        return {
          stage: s.stage as FunnelStage["stage"],
          count,
          value: toStringMinor(s.value ?? s.amount_minor),
          conversionRate,
        };
      });
      return { stages };
    },
    getInterventions: async (params?: { from?: string; to?: string }): Promise<{ stats: InterventionStat[] }> => {
      const raw = asRecord(await apiClient<unknown>("/analytics/interventions", { params }));
      // Backend returns { items: [{ type, cases, successes, recovered_minor, success_rate_bps }] }
      const rows = asArray(raw.stats ?? raw.items);
      const stats: InterventionStat[] = rows.map((row) => {
        const s = asRecord(row);
        const totalAttempts = numOr(s.totalAttempts ?? s.cases);
        const successfulAttempts = numOr(s.successfulAttempts ?? s.successes);
        const rateBps = s.success_rate_bps;
        return {
          actionType: strOr(s.actionType ?? s.type),
          totalAttempts,
          successfulAttempts,
          failedAttempts: numOr(s.failedAttempts, Math.max(0, totalAttempts - successfulAttempts)),
          successRate:
            typeof s.successRate === "number"
              ? s.successRate
              : typeof rateBps === "number"
                ? rateBps / 100
                : 0,
          totalRecovered: toStringMinor(s.totalRecovered ?? s.recovered_minor),
          averageCost: (s.averageCost as string | null) ?? null,
        };
      });
      return { stats };
    },
    getRiskMix: async (params?: { from?: string; to?: string }): Promise<{ mix: RiskMixItem[] }> => {
      const raw = asRecord(await apiClient<unknown>("/analytics/risk-mix", { params }));
      const items = asArray(raw.mix ?? raw.items);
      const mix: RiskMixItem[] = items.map((row) => {
        const m = asRecord(row);
        return {
          riskType: (m.riskType ?? m.risk_type) as RiskMixItem["riskType"],
          band: (m.band ?? m.risk_band) as RiskMixItem["band"],
          count: numOr(m.count),
          value: toStringMinor(m.value ?? m.amount_at_risk_minor),
        };
      });
      return { mix };
    },
    getAiPerformance: async (params?: { from?: string; to?: string }): Promise<AiPerformanceMetrics> => {
      const raw = asRecord(await apiClient<unknown>("/analytics/ai", { params }));
      if (Object.keys(raw).length === 0) return raw as unknown as AiPerformanceMetrics;
      if (raw.decisions !== undefined || raw.autonomy_rate_bps !== undefined) {
        const decisions = numOr(raw.decisions);
        const rejections = numOr(raw.policy_rejections);
        const approvals = numOr(raw.approvals_required);
        const autonomyRate =
          typeof raw.autonomyRate === "number"
            ? raw.autonomyRate
            : decisions > 0
              ? Math.round(((decisions - rejections - approvals) / decisions) * 1000) / 10
              : 100;
        const costBps = raw.cost_per_recovered_bps;
        return {
          totalRecommendations: numOr(raw.totalRecommendations, decisions),
          policyRejections: numOr(raw.policyRejections, rejections),
          humanApprovals: numOr(raw.humanApprovals, approvals),
          averageDecisionLatencyMs: numOr(raw.averageDecisionLatencyMs ?? raw.avg_decision_ms),
          fallbackCount: numOr(raw.fallbackCount),
          autonomyRate: typeof raw.autonomyRate === "number" ? raw.autonomyRate : Math.max(0, autonomyRate),
          aiCostPerRecoveredRupee:
            typeof raw.aiCostPerRecoveredRupee === "number"
              ? raw.aiCostPerRecoveredRupee
              : typeof costBps === "number"
                ? costBps / 10000
                : null,
        };
      }
      return raw as unknown as AiPerformanceMetrics;
    },
  },

  // Cases
  cases: {
    list: (params?: {
      status?: string;
      risk_type?: string;
      customer_id?: string;
      min_amount?: number;
      opened_from?: string;
      opened_to?: string;
      limit?: number;
      cursor?: string;
    }) => {
      // Backend validates customer_id as UUID; drop non-UUID input so a
      // free-text search never triggers a 400 that wipes the table.
      const safeParams = { ...params };
      if (safeParams.customer_id && !isUuid(safeParams.customer_id)) {
        delete safeParams.customer_id;
      }
      return apiClient<{ items: CaseSummary[]; nextCursor?: string }>("/cases", { params: safeParams });
    },
    getById: (id: string) => apiClient<CanonicalCaseDetail>(`/cases/${id}`),
    getTimeline: async (id: string, params?: { limit?: number; cursor?: string; order?: "asc" | "desc" }) => {
      const raw = asRecord(await apiClient<unknown>(`/cases/${id}/timeline`, { params }));
      // Backend TimelineService returns camelCase entries:
      // { id, at, type/eventType, actor:{type,id}, description, data/payload }.
      // Normalize to the frontend TimelineItem snake_case contract.
      const items: TimelineItem[] = asArray(raw.items).map(normalizeTimelineItem);
      const nextCursor = typeof raw.nextCursor === "string" ? raw.nextCursor : undefined;
      return { items, nextCursor };
    },
    pause: (id: string) => apiClient<{ success: boolean; status: string }>(`/cases/${id}/pause`, { method: "POST" }),
    resume: (id: string) => apiClient<{ success: boolean; status: string }>(`/cases/${id}/resume`, { method: "POST" }),
    escalate: (id: string, notes?: string) =>
      apiClient<{ success: boolean; status: string }>(`/cases/${id}/escalate`, {
        method: "POST",
        body: JSON.stringify({ notes }),
      }),
    stop: (id: string, reason: string) =>
      apiClient<{ success: boolean; status: string }>(`/cases/${id}/stop`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
  },

  // Risks
  risks: {
    list: async (params?: {
      status?: string;
      band?: string;
      risk_type?: string;
      customer_id?: string;
      limit?: number;
      cursor?: string;
    }) => {
      const safeParams = { ...params };
      if (safeParams.customer_id && !isUuid(safeParams.customer_id)) {
        delete safeParams.customer_id;
      }
      const raw = asRecord(await apiClient<unknown>("/risks", { params: safeParams }));
      // Backend returns camelCase drizzle rows; normalize to snake_case.
      const items: RiskEvaluationItem[] = asArray(raw.items).map(normalizeRiskItem);
      const nextCursor = typeof raw.nextCursor === "string" ? raw.nextCursor : undefined;
      return { items, nextCursor };
    },
    getById: async (id: string) => {
      const raw = await apiClient<unknown>(`/risks/${id}`);
      return normalizeRiskItem(raw);
    },
  },

  // Human Tasks
  tasks: {
    list: async (params?: {
      status?: string;
      type?: string;
      assigned_to?: string;
      priority?: string;
      assigned_to_user_id?: string;
      limit?: number;
      offset?: number;
      cursor?: string;
    }) => {
      // Backend supports { status, type, assigned_to, overdue, limit, offset }.
      // Legacy frontend params (priority filter, cursor, assigned_to_user_id)
      // are translated or dropped so live data always loads.
      const query: Record<string, string | number | boolean | undefined | null> = {
        status: params?.status,
        type: params?.type,
        limit: params?.limit,
      };
      const assignedTo = pick(params?.assigned_to, params?.assigned_to_user_id);
      if (assignedTo && isUuid(assignedTo)) {
        query.assigned_to = assignedTo;
      }
      if (params?.offset !== undefined) {
        query.offset = params.offset;
      } else if (params?.cursor && /^\d+$/.test(params.cursor)) {
        query.offset = parseInt(params.cursor, 10);
      }
      const raw = asRecord(await apiClient<unknown>("/human-tasks", { params: query }));
      const items: HumanTask[] = asArray(raw.items).map(normalizeHumanTask);
      // Backend returns { items, total } (offset-based); synthesize a cursor
      // only when more rows may exist.
      const total = typeof raw.total === "number" ? raw.total : undefined;
      let nextCursor = typeof raw.nextCursor === "string" ? raw.nextCursor : undefined;
      if (!nextCursor && total !== undefined && params?.limit) {
        const offset = query.offset ? Number(query.offset) : 0;
        if (offset + items.length < total) {
          nextCursor = String(offset + items.length);
        }
      }
      return { items, nextCursor, total };
    },
    getById: async (id: string) => {
      const raw = await apiClient<unknown>(`/human-tasks/${id}`);
      return normalizeHumanTask(raw);
    },
    approve: (id: string, notes?: string) =>
      apiClient<{ success: boolean; task?: HumanTask; status?: string; taskId?: string }>(`/human-tasks/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ notes }),
      }),
    reject: (id: string, notes: string) =>
      apiClient<{ success: boolean; task?: HumanTask; status?: string; taskId?: string }>(`/human-tasks/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ notes }),
      }),
    assign: (id: string, assignee_user_id: string | null) =>
      apiClient<{ success: boolean; task?: HumanTask }>(`/human-tasks/${id}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignee_user_id }),
      }),
  },

  // Policies
  policies: {
    list: async (): Promise<{ policies: PolicyRule[] }> => {
      const res = asRecord(await apiClient<unknown>("/policies"));
      const policies: PolicyRule[] = asArray(res.policies).map((row) => {
        const p = asRecord(row);
        const code = strOr(p.code);
        return {
          id: strOr(p.id),
          tenant_id: strOr(field(p, "tenant_id", "tenantId")),
          code,
          name: strOr(p.name),
          description: strOr(p.description),
          category: strOr(p.category) || inferPolicyCategory(code),
          rule_type: strOr(field(p, "rule_type", "ruleKind", "rule_kind"), "REJECT"),
          parameters: asRecord(field(p, "parameters", "definition", "snapshot")),
          enabled: p.enabled === true,
          version: numOr(field(p, "version", "activeVersion"), 1),
          created_at: strOr(field(p, "created_at", "createdAt")),
          updated_at: strOr(field(p, "updated_at", "updatedAt")),
        };
      });
      return { policies };
    },
    create: (body: {
      code: string;
      name: string;
      description?: string;
      ruleKind?: string;
      rule_kind?: string;
      rule_type?: string;
      category?: string;
      definition?: Record<string, unknown>;
      parameters?: Record<string, unknown>;
      enabled?: boolean;
    }) =>
      apiClient<PolicyRule>("/policies", {
        method: "POST",
        // Backend CreatePolicyRuleSchema requires { code, name, definition }.
        // Frontend-only `category` / `parameters` aliases are translated here.
        body: JSON.stringify({
          code: body.code,
          name: body.name,
          description: body.description,
          ruleKind: body.ruleKind ?? body.rule_kind ?? body.rule_type ?? "REJECT",
          definition: body.definition ?? body.parameters ?? {},
          enabled: body.enabled ?? true,
        }),
      }),
    update: (
      id: string,
      body: {
        name?: string;
        description?: string;
        definition?: Record<string, unknown>;
        parameters?: Record<string, unknown>;
        enabled?: boolean;
      },
    ) =>
      apiClient<PolicyRule>(`/policies/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: body.name,
          description: body.description,
          definition: body.definition ?? body.parameters,
          enabled: body.enabled,
        }),
      }),
    getVersions: async (id: string) => {
      const res = asRecord(await apiClient<unknown>(`/policies/${id}/versions`));
      // Backend returns drizzle rows { ruleId, version, snapshot, createdBy, createdAt }.
      const versions: PolicyVersion[] = asArray(res.versions).map((row) => {
        const v = asRecord(row);
        return {
          id: strOr(v.id),
          rule_id: strOr(field(v, "rule_id", "ruleId"), id),
          version: numOr(v.version),
          parameters: asRecord(field(v, "parameters", "snapshot")),
          enabled: v.enabled !== false,
          changed_by: strOr(field(v, "changed_by", "createdBy")),
          changed_at: strOr(field(v, "changed_at", "createdAt")),
          reason: typeof v.reason === "string" ? v.reason : undefined,
        };
      });
      return { versions };
    },
  },

  // Audit
  audit: {
    list: async (params?: {
      case_id?: string;
      actor_type?: string;
      event?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: string;
    }) => {
      const raw = asRecord(await apiClient<unknown>("/audit", { params }));
      // Backend returns camelCase drizzle rows; normalize to snake_case.
      const items: AuditLogItem[] = asArray(raw.items).map(normalizeAuditItem);
      const nextCursor = typeof raw.nextCursor === "string" ? raw.nextCursor : undefined;
      return { items, nextCursor };
    },
  },

  // Admin
  admin: {
    listUsers: () => apiClient<{ users: User[] }>("/admin/users"),
    createUser: (body: { email: string; password: string; role: string; name: string }) =>
      apiClient<{ user: User }>("/admin/users", {
        method: "POST",
        // Backend createUserSchema requires { email, name, password, role }.
        body: JSON.stringify(body),
      }),
    updateUser: (id: string, body: { role?: string; status?: string }) =>
      apiClient<{ user: User }>(`/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    listApiKeys: async () => {
      const raw = await apiClient<unknown>("/admin/api-keys");
      // Backend returns a bare array [{ id, name, prefix, scopes, ... }].
      const rows = Array.isArray(raw) ? raw : asArray(asRecord(raw).apiKeys ?? asRecord(raw).keys);
      return rows.map(normalizeApiKey);
    },
    createApiKey: async (body: { name: string; scopes: string[]; expires_in_days?: number }) => {
      const raw = asRecord(
        await apiClient<unknown>("/admin/api-keys", {
          method: "POST",
          // Backend createApiKeySchema accepts { name, scopes }; expiry is ignored.
          body: JSON.stringify({ name: body.name, scopes: body.scopes }),
        }),
      );
      // Backend returns { id, name, key, prefix, scopes, createdAt } (raw key once).
      const nested = asRecord(raw.apiKey);
      const source: JsonRecord = Object.keys(nested).length > 0 ? nested : raw;
      const apiKey: ApiKey = {
        id: strOr(source.id),
        tenantId: strOr(field(source, "tenantId", "tenant_id")),
        name: strOr(source.name, body.name),
        keyPrefix: strOr(field(source, "keyPrefix", "prefix")),
        scopes: asArray(source.scopes).filter((s): s is string => typeof s === "string").length > 0
          ? asArray(source.scopes).filter((s): s is string => typeof s === "string")
          : body.scopes,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: strOr(field(source, "createdAt", "created_at"), new Date().toISOString()),
      };
      const rawKey: string = strOr(raw.rawKey ?? raw.key);
      return { apiKey, rawKey };
    },
    revokeApiKey: (id: string) => apiClient<void>(`/admin/api-keys/${id}`, { method: "DELETE" }),
  },

  // Demo Mock Overrides
  demo: {
    setPaymentOutcomeOverride: (
      key: string,
      body: {
        status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "ACCEPTED_ASYNC";
        failureCode?: string;
        failureMessage?: string;
        feeAmount?: number;
        delayMs?: number;
      },
    ) =>
      apiClient<{ success: boolean; configured: unknown }>(
        `/demo/mock/payments/${key}/next-outcome`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
  },
};

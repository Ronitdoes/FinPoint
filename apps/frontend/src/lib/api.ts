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
    const errorEnvelope = (typeof data === "object" && data !== null ? data : {}) as {
      error?: { code?: string; message?: string; details?: unknown };
      code?: string;
      message?: string;
      details?: unknown;
    };
    const errCode = errorEnvelope.error?.code || errorEnvelope.code || "API_ERROR";
    const errMessage =
      errorEnvelope.error?.message || errorEnvelope.message || response.statusText || "An error occurred";
    const errDetails = errorEnvelope.error?.details || errorEnvelope.details;
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
    getSummary: (params?: { from?: string; to?: string }) =>
      apiClient<AnalyticsSummary>("/analytics/summary", { params }),
    getRecoveryTimeseries: (params?: { from?: string; to?: string; bucket?: "day" | "week" }) =>
      apiClient<{ points: RecoveryTimeseriesPoint[] }>("/analytics/recovery", { params }),
    getFunnel: (params?: { from?: string; to?: string }) =>
      apiClient<{ stages: FunnelStage[] }>("/analytics/funnel", { params }),
    getInterventions: (params?: { from?: string; to?: string }) =>
      apiClient<{ stats: InterventionStat[] }>("/analytics/interventions", { params }),
    getRiskMix: (params?: { from?: string; to?: string }) =>
      apiClient<{ mix: RiskMixItem[] }>("/analytics/risk-mix", { params }),
    getAiPerformance: (params?: { from?: string; to?: string }) =>
      apiClient<AiPerformanceMetrics>("/analytics/ai", { params }),
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
    }) =>
      apiClient<{ items: CaseSummary[]; nextCursor?: string }>("/cases", { params }),
    getById: (id: string) => apiClient<CanonicalCaseDetail>(`/cases/${id}`),
    getTimeline: (id: string, params?: { limit?: number; cursor?: string; order?: "asc" | "desc" }) =>
      apiClient<{ items: TimelineItem[]; nextCursor?: string }>(`/cases/${id}/timeline`, { params }),
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
    list: (params?: {
      status?: string;
      band?: string;
      risk_type?: string;
      customer_id?: string;
      limit?: number;
      cursor?: string;
    }) =>
      apiClient<{ items: RiskEvaluationItem[]; nextCursor?: string }>("/risks", { params }),
    getById: (id: string) => apiClient<RiskEvaluationItem>(`/risks/${id}`),
  },

  // Human Tasks
  tasks: {
    list: (params?: {
      status?: string;
      priority?: string;
      assigned_to_user_id?: string;
      limit?: number;
      cursor?: string;
    }) =>
      apiClient<{ items: HumanTask[]; nextCursor?: string }>("/human-tasks", { params }),
    getById: (id: string) => apiClient<HumanTask>(`/human-tasks/${id}`),
    approve: (id: string, notes?: string) =>
      apiClient<{ success: boolean; task: HumanTask }>(`/human-tasks/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ notes }),
      }),
    reject: (id: string, notes: string) =>
      apiClient<{ success: boolean; task: HumanTask }>(`/human-tasks/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ notes }),
      }),
    assign: (id: string, assignee_user_id: string | null) =>
      apiClient<{ success: boolean; task: HumanTask }>(`/human-tasks/${id}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignee_user_id }),
      }),
  },

  // Policies
  policies: {
    list: () => apiClient<{ policies: PolicyRule[] }>("/policies"),
    create: (body: {
      name: string;
      description?: string;
      category: string;
      rule_type: string;
      parameters: Record<string, unknown>;
      enabled?: boolean;
    }) =>
      apiClient<PolicyRule>("/policies", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (
      id: string,
      body: {
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
        enabled?: boolean;
      },
    ) =>
      apiClient<PolicyRule>(`/policies/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    getVersions: (id: string) =>
      apiClient<{ versions: PolicyVersion[] }>(`/policies/${id}/versions`),
  },

  // Audit
  audit: {
    list: (params?: {
      case_id?: string;
      actor_type?: string;
      event?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: string;
    }) =>
      apiClient<{ items: AuditLogItem[]; nextCursor?: string }>("/audit", { params }),
  },

  // Admin
  admin: {
    listUsers: () => apiClient<{ users: User[] }>("/admin/users"),
    createUser: (body: { email: string; password?: string; role: string; name?: string }) =>
      apiClient<{ user: User }>("/admin/users", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    updateUser: (id: string, body: { role?: string; status?: string }) =>
      apiClient<{ user: User }>(`/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    listApiKeys: () => apiClient<ApiKey[]>("/admin/api-keys"),
    createApiKey: (body: { name: string; scopes: string[]; expires_in_days?: number }) =>
      apiClient<{ apiKey: ApiKey; rawKey: string }>("/admin/api-keys", {
        method: "POST",
        body: JSON.stringify(body),
      }),
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

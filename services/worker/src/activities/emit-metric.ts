import {
  workflowStartedTotal,
  workflowOutcomeTotal,
  metricsRegistry,
} from "@repo/observability";
import {
  type ActivityContext,
  withActivityContext,
} from "../framework";

export interface EmitMetricInput extends ActivityContext {
  metricName: "workflow_started_total" | "workflow_outcome_total" | string;
  labels?: Record<string, string>;
  value?: number;
}

export interface EmitMetricResult {
  success: boolean;
}

/**
 * Activity: emitMetric
 * Emits Prometheus metrics for workflow milestones and outcomes.
 */
export async function emitMetric(
  input: EmitMetricInput,
): Promise<EmitMetricResult> {
  return await withActivityContext("emitMetric", input, async () => {
    if (input.metricName === "workflow_started_total") {
      workflowStartedTotal.inc({
        type: input.labels?.type ?? "RECOVERY_PAYMENT",
      });
    } else if (input.metricName === "workflow_outcome_total") {
      workflowOutcomeTotal.inc({
        type: input.labels?.type ?? "RECOVERY_PAYMENT",
        result: input.labels?.result ?? "COMPLETED",
      });
    } else {
      // Custom metric lookup or no-op
      try {
        const metric = metricsRegistry.getSingleMetric(input.metricName);
        if (metric && "inc" in metric && typeof (metric as { inc: unknown }).inc === "function") {
          (metric as { inc: (labels: Record<string, string>, value: number) => void }).inc(
            input.labels ?? {},
            input.value ?? 1,
          );
        }
      } catch {
        // Silently skip unregistered custom metric
      }
    }

    return { success: true };
  });
}

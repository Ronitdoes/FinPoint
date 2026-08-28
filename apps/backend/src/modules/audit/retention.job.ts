import type { RepoContext } from "@repo/db/repositories";
import * as repos from "@repo/db/repositories";

export interface RetentionJobOptions {
  retentionMonths?: number;
  batchSize?: number;
  dryRun?: boolean;
}

export interface RetentionJobResult {
  archivedCount: number;
  cutoffDate: Date;
  dryRun: boolean;
}

/**
 * Retention policy job skeleton (Spec 01 §18, Step 25).
 * Prunes audit records older than N months and archives them into cold storage table audit_archive.
 * Full production scheduling deferred to Ops Step 34.
 */
export async function archiveExpiredAuditLogs(
  ctx: RepoContext,
  options: RetentionJobOptions = {},
): Promise<RetentionJobResult> {
  const retentionMonths = options.retentionMonths ?? 12;
  const batchSize = options.batchSize ?? 500;
  const dryRun = options.dryRun ?? false;

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);

  if (dryRun) {
    return {
      archivedCount: 0,
      cutoffDate,
      dryRun: true,
    };
  }

  const result = await repos.archiveAuditLogsBatch(ctx, {
    cutoffDate,
    batchSize,
  });

  return {
    archivedCount: result.archivedCount,
    cutoffDate,
    dryRun: false,
  };
}

export class AuditRetentionJob {
  constructor(private readonly ctx: RepoContext) {}

  async run(options: RetentionJobOptions = {}): Promise<RetentionJobResult> {
    return await archiveExpiredAuditLogs(this.ctx, options);
  }
}

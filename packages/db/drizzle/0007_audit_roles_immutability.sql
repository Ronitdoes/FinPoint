CREATE TABLE IF NOT EXISTS "audit_archive" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"event" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_archive" ADD CONSTRAINT "audit_archive_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_archive" ADD CONSTRAINT "audit_archive_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_archive_case_created_at_idx" ON "audit_archive" USING btree ("case_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_archive_tenant_created_at_idx" ON "audit_archive" USING btree ("tenant_id","created_at" desc);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_archive_archived_at_idx" ON "audit_archive" USING btree ("archived_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit records and case events are append-only and immutable. Operation % is prohibited on %.', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_case_events_immutable ON case_events;
--> statement-breakpoint
CREATE TRIGGER trg_case_events_immutable
BEFORE UPDATE OR DELETE ON case_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_audit_archive_immutable ON audit_archive;
--> statement-breakpoint
CREATE TRIGGER trg_audit_archive_immutable
BEFORE UPDATE OR DELETE ON audit_archive
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_writer') THEN
    CREATE ROLE audit_writer;
  END IF;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_logs, case_events, audit_archive TO app_rw;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, case_events, audit_archive FROM app_rw;
--> statement-breakpoint
GRANT INSERT, SELECT ON audit_logs, case_events, audit_archive TO audit_writer;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, case_events, audit_archive FROM audit_writer;

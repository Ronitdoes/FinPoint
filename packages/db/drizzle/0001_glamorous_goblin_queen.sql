CREATE TYPE "public"."action_status" AS ENUM('PROPOSED', 'APPROVAL_REQUIRED', 'APPROVED', 'POLICY_REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'CANCELLED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."action_type" AS ENUM('RETRY_PAYMENT', 'CREATE_PAYMENT_LINK', 'SEND_EMAIL', 'SEND_WHATSAPP', 'SEND_SMS', 'OFFER_INCENTIVE', 'REQUEST_PAYMENT_METHOD_UPDATE', 'CREATE_PROMISE_TO_PAY', 'CREATE_HUMAN_TASK', 'PAUSE_CASE', 'STOP_CASE');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('SYSTEM', 'AI', 'USER', 'WORKFLOW', 'PROVIDER');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('DETECTED', 'QUALIFIED', 'DECISION_PENDING', 'POLICY_REVIEW', 'IN_PROGRESS', 'WAITING', 'RECOVERED', 'STOPPED', 'ESCALATED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('WHATSAPP', 'EMAIL', 'SMS');--> statement-breakpoint
CREATE TYPE "public"."customer_response_type" AS ENUM('REPLY', 'OPT_OUT', 'PROMISE_TO_PAY', 'COMPLAINT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('COMPLETED', 'INVALID_OUTPUT', 'FALLBACK_RULE_BASED', 'FAILED', 'POLICY_REJECTED');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('STRIPE', 'RAZORPAY', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('payment.created', 'payment.pending', 'payment.failed', 'payment.succeeded', 'payment.refunded', 'payment.disputed', 'checkout.started', 'checkout.item_added', 'checkout.payment_started', 'checkout.abandoned', 'checkout.completed', 'subscription.created', 'subscription.payment_failed', 'subscription.renewed', 'subscription.cancelled', 'invoice.created', 'invoice.due', 'invoice.overdue', 'invoice.paid', 'invoice.disputed', 'customer.replied', 'customer.opted_out', 'customer.payment_method_changed', 'customer_promised_to_pay', 'customer_payment_received');--> statement-breakpoint
CREATE TYPE "public"."human_task_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."human_task_status" AS ENUM('PENDING', 'ASSIGNED', 'APPROVED', 'REJECTED', 'RESOLVED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."human_task_type" AS ENUM('APPROVAL', 'DISPUTE_REVIEW', 'COMPLIANCE_REVIEW', 'WORKFLOW_FAILURE', 'GENERAL');--> statement-breakpoint
CREATE TYPE "public"."idempotency_key_status" AS ENUM('PROCESSING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('OUTBOUND', 'INBOUND');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."messaging_provider" AS ENUM('WHATSAPP_CLOUD', 'SMTP_EMAIL', 'MOCK');--> statement-breakpoint
CREATE TYPE "public"."policy_result" AS ENUM('ALLOWED', 'REJECTED', 'REQUIRE_APPROVAL');--> statement-breakpoint
CREATE TYPE "public"."policy_rule_kind" AS ENUM('REJECT', 'REQUIRE_APPROVAL', 'LIMIT');--> statement-breakpoint
CREATE TYPE "public"."promise_to_pay_status" AS ENUM('MADE', 'HONORED', 'BROKEN', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."recovery_cost_category" AS ENUM('LLM', 'MESSAGING', 'PAYMENT_PROCESSING', 'DISCOUNT', 'MANUAL_HANDLING', 'PROVIDER');--> statement-breakpoint
CREATE TYPE "public"."risk_band" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."risk_status" AS ENUM('OPEN', 'ASSESSED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."risk_type" AS ENUM('PAYMENT_FAILURE', 'CHECKOUT_ABANDONMENT', 'INVOICE_OVERDUE');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'CONTINUED_AS_NEW');--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "event_source" NOT NULL,
	"external_event_id" text,
	"type" "event_type" NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"entity_type" text,
	"entity_id" text,
	"raw_payload" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" uuid NOT NULL,
	"status" "event_status" DEFAULT 'RECEIVED' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "revenue_risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"risk_type" "risk_type" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"band" "risk_band" NOT NULL,
	"factors" jsonb NOT NULL,
	"status" "risk_status" DEFAULT 'OPEN' NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_risks_score_check" CHECK ("revenue_risks"."score" >= 0 AND "revenue_risks"."score" <= 100)
);
--> statement-breakpoint
CREATE TABLE "recovery_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"risk_id" uuid,
	"risk_type" "risk_type" NOT NULL,
	"source_entity_type" text NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"amount_at_risk" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"risk_score" integer NOT NULL,
	"status" "case_status" DEFAULT 'DETECTED' NOT NULL,
	"status_reason" text,
	"stop_conditions" text[] DEFAULT '{}'::text[] NOT NULL,
	"assigned_to" uuid,
	"workflow_id" uuid,
	"attribution_window_hours" integer DEFAULT 72 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_cases_amount_at_risk_check" CHECK ("recovery_cases"."amount_at_risk" > 0)
);
--> statement-breakpoint
CREATE TABLE "ai_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"model" text NOT NULL,
	"model_version" text,
	"prompt_version" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"output_raw" jsonb,
	"diagnosis_cause" text,
	"diagnosis_confidence" numeric(3, 2),
	"recommended_actions" jsonb NOT NULL,
	"stop_conditions" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "decision_status" NOT NULL,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_minor_units" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_decisions_confidence_check" CHECK ("ai_decisions"."diagnosis_confidence" IS NULL OR ("ai_decisions"."diagnosis_confidence" >= 0 AND "ai_decisions"."diagnosis_confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "recovery_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"decision_id" uuid,
	"type" "action_type" NOT NULL,
	"parameters" jsonb NOT NULL,
	"status" "action_status" DEFAULT 'PROPOSED' NOT NULL,
	"policy_result" jsonb,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workflow_row_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"temporal_workflow_id" text NOT NULL,
	"run_id" text,
	"type" text NOT NULL,
	"status" "workflow_status" DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"case_id" uuid,
	"channel" "channel",
	"type" "customer_response_type" NOT NULL,
	"content_redacted" text,
	"raw_ref" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_delivery_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"status" "message_status" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid,
	"customer_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"direction" "message_direction" DEFAULT 'OUTBOUND' NOT NULL,
	"template_id" text NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"to_address" text NOT NULL,
	"provider" "messaging_provider" NOT NULL,
	"provider_message_id" text,
	"idempotency_key" text NOT NULL,
	"status" "message_status" DEFAULT 'QUEUED' NOT NULL,
	"sent_at" timestamp with time zone,
	"final_status_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promises_to_pay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"promised_amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"promised_by_date" date NOT NULL,
	"status" "promise_to_pay_status" DEFAULT 'MADE' NOT NULL,
	"honored_payment_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promises_to_pay_amount_check" CHECK ("promises_to_pay"."promised_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "human_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"type" "human_task_type" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" "human_task_priority" DEFAULT 'MEDIUM' NOT NULL,
	"status" "human_task_status" DEFAULT 'PENDING' NOT NULL,
	"assigned_to" uuid,
	"sla_due_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_notes" text,
	"decided_at" timestamp with time zone,
	"temporal_signal_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid,
	"decision_id" uuid,
	"rule_versions" uuid[] NOT NULL,
	"result" "policy_result" NOT NULL,
	"rejections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_actions" jsonb NOT NULL,
	"latency_ms" integer NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rule_kind" "policy_rule_kind" NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"event" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"description" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_cost_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"category" "recovery_cost_category" NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"incurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"baseline_amount" bigint NOT NULL,
	"recovered_amount" bigint NOT NULL,
	"recovery_cost" bigint DEFAULT 0 NOT NULL,
	"net_recovered" bigint GENERATED ALWAYS AS ("recovered_amount" - "recovery_cost") STORED,
	"attribution_method" text NOT NULL,
	"attribution_window_hours" integer NOT NULL,
	"recovered_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"response_snapshot" jsonb,
	"status" "idempotency_key_status" DEFAULT 'PROCESSING' NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_risks" ADD CONSTRAINT "revenue_risks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_risks" ADD CONSTRAINT "revenue_risks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_risk_id_revenue_risks_id_fk" FOREIGN KEY ("risk_id") REFERENCES "public"."revenue_risks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_decision_id_ai_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."ai_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workflow_row_id_workflows_id_fk" FOREIGN KEY ("workflow_row_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_responses" ADD CONSTRAINT "customer_responses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_responses" ADD CONSTRAINT "customer_responses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_responses" ADD CONSTRAINT "customer_responses_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_delivery_events" ADD CONSTRAINT "message_delivery_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_honored_payment_id_payments_id_fk" FOREIGN KEY ("honored_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_decision_id_ai_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."ai_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_rule_id_policy_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."policy_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cost_entries" ADD CONSTRAINT "recovery_cost_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cost_entries" ADD CONSTRAINT "recovery_cost_entries_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_outcomes" ADD CONSTRAINT "recovery_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_outcomes" ADD CONSTRAINT "recovery_outcomes_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_outcomes" ADD CONSTRAINT "recovery_outcomes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_external_event_id_unique" ON "events" USING btree ("source","external_event_id") WHERE "events"."external_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_tenant_type_received_at_idx" ON "events" USING btree ("tenant_id","type","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_status_unprocessed_idx" ON "events" USING btree ("status") WHERE "events"."status" != 'PROCESSED';--> statement-breakpoint
CREATE INDEX "events_tenant_id_idx" ON "events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "events_customer_id_idx" ON "events" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "revenue_risks_status_score_idx" ON "revenue_risks" USING btree ("status","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "revenue_risks_tenant_subject_idx" ON "revenue_risks" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "revenue_risks_tenant_id_idx" ON "revenue_risks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "revenue_risks_customer_id_idx" ON "revenue_risks" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_tenant_case_number_unique" ON "recovery_cases" USING btree ("tenant_id","case_number");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_tenant_source_entity_live_unique" ON "recovery_cases" USING btree ("tenant_id","source_entity_type","source_entity_id") WHERE "recovery_cases"."status" NOT IN ('RECOVERED', 'STOPPED', 'FAILED');--> statement-breakpoint
CREATE INDEX "recovery_cases_status_opened_at_idx" ON "recovery_cases" USING btree ("status","opened_at");--> statement-breakpoint
CREATE INDEX "recovery_cases_customer_id_idx" ON "recovery_cases" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "recovery_cases_tenant_status_idx" ON "recovery_cases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "recovery_cases_tenant_id_idx" ON "recovery_cases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ai_decisions_case_created_at_idx" ON "ai_decisions" USING btree ("case_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_decisions_tenant_id_idx" ON "ai_decisions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_actions_idempotency_key_unique" ON "recovery_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "recovery_actions_case_created_at_idx" ON "recovery_actions" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "recovery_actions_tenant_id_idx" ON "recovery_actions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workflow_events_workflow_occurred_at_idx" ON "workflow_events" USING btree ("workflow_row_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_case_id_unique" ON "workflows" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_temporal_workflow_id_unique" ON "workflows" USING btree ("temporal_workflow_id");--> statement-breakpoint
CREATE INDEX "workflows_tenant_id_idx" ON "workflows" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "customer_responses_customer_received_at_idx" ON "customer_responses" USING btree ("customer_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_responses_case_id_idx" ON "customer_responses" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "customer_responses_tenant_id_idx" ON "customer_responses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "message_delivery_events_message_occurred_at_idx" ON "message_delivery_events" USING btree ("message_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_key_unique" ON "messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_case_created_at_idx" ON "messages" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_customer_channel_sent_at_idx" ON "messages" USING btree ("customer_id","channel","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_tenant_id_idx" ON "messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "promises_to_pay_case_id_idx" ON "promises_to_pay" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "promises_to_pay_tenant_id_idx" ON "promises_to_pay" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "human_tasks_status_sla_due_at_idx" ON "human_tasks" USING btree ("status","sla_due_at");--> statement-breakpoint
CREATE INDEX "human_tasks_case_id_idx" ON "human_tasks" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "human_tasks_tenant_id_idx" ON "human_tasks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "policy_evaluations_tenant_id_idx" ON "policy_evaluations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "policy_evaluations_case_id_idx" ON "policy_evaluations" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_rules_code_unique" ON "policy_rules" USING btree ("code");--> statement-breakpoint
CREATE INDEX "policy_rules_tenant_id_idx" ON "policy_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_rule_version_unique" ON "policy_versions" USING btree ("rule_id","version");--> statement-breakpoint
CREATE INDEX "policy_versions_rule_id_idx" ON "policy_versions" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "audit_logs_case_created_at_idx" ON "audit_logs" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_at_idx" ON "audit_logs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "case_events_case_occurred_at_idx" ON "case_events" USING btree ("case_id","occurred_at");--> statement-breakpoint
CREATE INDEX "case_events_tenant_id_idx" ON "case_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "recovery_cost_entries_case_category_idx" ON "recovery_cost_entries" USING btree ("case_id","category");--> statement-breakpoint
CREATE INDEX "recovery_cost_entries_tenant_id_idx" ON "recovery_cost_entries" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_outcomes_case_id_unique" ON "recovery_outcomes" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "recovery_outcomes_tenant_id_idx" ON "recovery_outcomes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "recovery_outcomes_payment_id_idx" ON "recovery_outcomes" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");
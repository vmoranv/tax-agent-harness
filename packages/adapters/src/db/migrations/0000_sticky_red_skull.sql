CREATE TABLE "access_grant" (
	"user_id" text NOT NULL,
	"enterprise_id" text NOT NULL,
	"access_level" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"granted_by" text NOT NULL,
	CONSTRAINT "access_grant_user_id_enterprise_id_pk" PRIMARY KEY("user_id","enterprise_id")
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_txn" (
	"enterprise_id" text NOT NULL,
	"txn_no" text NOT NULL,
	"traded_on" date NOT NULL,
	"direction" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"counterparty" text NOT NULL,
	"remark" text,
	CONSTRAINT "bank_txn_enterprise_id_txn_no_pk" PRIMARY KEY("enterprise_id","txn_no")
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"enterprise_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_message" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_call_id" text,
	"tool_name" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise" (
	"id" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_alias" (
	"enterprise_id" text NOT NULL,
	"alias" text NOT NULL,
	CONSTRAINT "enterprise_alias_enterprise_id_alias_pk" PRIMARY KEY("enterprise_id","alias")
);
--> statement-breakpoint
CREATE TABLE "invoice" (
	"enterprise_id" text NOT NULL,
	"invoice_no" text NOT NULL,
	"issued_on" date NOT NULL,
	"seller_name" text NOT NULL,
	"item_name" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"purpose" text,
	"remark" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "invoice_enterprise_id_invoice_no_pk" PRIMARY KEY("enterprise_id","invoice_no")
);
--> statement-breakpoint
CREATE TABLE "invoice_write_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"enterprise_id" text NOT NULL,
	"invoice_no" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference" (
	"user_id" text NOT NULL,
	"enterprise_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "preference_user_id_enterprise_id_key_pk" PRIMARY KEY("user_id","enterprise_id","key")
);
--> statement-breakpoint
CREATE TABLE "rule_doc" (
	"code" text NOT NULL,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_ent" text,
	"effective_from" date NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	"supersedes" text,
	"superseded_by" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rule_doc_code_version_pk" PRIMARY KEY("code","version")
);
--> statement-breakpoint
CREATE TABLE "rule_obligation" (
	"code" text NOT NULL,
	"version" text NOT NULL,
	"kind" text NOT NULL,
	"threshold_cents" bigint,
	CONSTRAINT "rule_obligation_code_version_pk" PRIMARY KEY("code","version")
);
--> statement-breakpoint
CREATE TABLE "task_card" (
	"user_id" text NOT NULL,
	"enterprise_id" text NOT NULL,
	"month" date NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_card_user_id_enterprise_id_pk" PRIMARY KEY("user_id","enterprise_id")
);
--> statement-breakpoint
CREATE TABLE "task_item" (
	"user_id" text NOT NULL,
	"enterprise_id" text NOT NULL,
	"invoice_no" text NOT NULL,
	"state" text NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_item_user_id_enterprise_id_invoice_no_pk" PRIMARY KEY("user_id","enterprise_id","invoice_no")
);
--> statement-breakpoint
CREATE TABLE "trace_run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text,
	"user_id" text,
	"enterprise_id" text,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"elapsed_ms" integer,
	"instructions" text,
	"instructions_hash" text,
	"estimated_tokens" integer,
	"degrade_level" text,
	"final_text" text,
	"error_code" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "trace_step" (
	"run_id" text NOT NULL,
	"idx" integer NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "trace_step_run_id_idx_pk" PRIMARY KEY("run_id","idx")
);
--> statement-breakpoint
CREATE TABLE "trace_tool_call" (
	"run_id" text NOT NULL,
	"call_id" text NOT NULL,
	"name" text NOT NULL,
	"args" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"result" jsonb,
	"error_code" text,
	"elapsed_ms" integer NOT NULL,
	CONSTRAINT "trace_tool_call_run_id_call_id_pk" PRIMARY KEY("run_id","call_id")
);
--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_txn" ADD CONSTRAINT "bank_txn_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_alias" ADD CONSTRAINT "enterprise_alias_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_doc" ADD CONSTRAINT "rule_doc_scope_ent_enterprise_id_fk" FOREIGN KEY ("scope_ent") REFERENCES "public"."enterprise"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_step" ADD CONSTRAINT "trace_step_run_id_trace_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."trace_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_tool_call" ADD CONSTRAINT "trace_tool_call_run_id_trace_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."trace_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bank_month" ON "bank_txn" USING btree ("enterprise_id",date_trunc('month', "traded_on"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_message_seq" ON "conversation_message" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "idx_invoice_month" ON "invoice" USING btree ("enterprise_id",date_trunc('month', "issued_on"));--> statement-breakpoint
CREATE INDEX "idx_invoice_missing_purpose" ON "invoice" USING btree ("enterprise_id",date_trunc('month', "issued_on"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_write_log_run" ON "invoice_write_log" USING btree ("enterprise_id","invoice_no","field","new_value","run_id");--> statement-breakpoint
CREATE INDEX "idx_write_log_time" ON "invoice_write_log" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_rule_scope" ON "rule_doc" USING btree ("scope_kind","status","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_card_active" ON "task_card" USING btree ("user_id","enterprise_id") WHERE "task_card"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_trace_time" ON "trace_run" USING btree ("started_at" DESC);
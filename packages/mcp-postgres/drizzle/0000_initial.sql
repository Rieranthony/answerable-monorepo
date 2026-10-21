CREATE TABLE "evidence_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"client_id" text,
	"capability_identity" text,
	"capability_version" text,
	"execution_id" uuid,
	"intent_id" uuid,
	"receipt_id" uuid,
	"upstream" text,
	"outcome" text NOT NULL,
	"reason" text,
	"error_code" text,
	"request_id" text,
	"trace_id" text,
	"span_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_ref" uuid,
	"payload_hash" text,
	"prev_hash" text NOT NULL,
	"row_hash" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "evidence_events_organisation_id_seq_key" UNIQUE("organisation_id","seq"),
	CONSTRAINT "evidence_events_kind_check" CHECK ("evidence_events"."kind" in ('capability.completed', 'capability.denied', 'intent.prepared', 'intent.approval_requested', 'intent.committed', 'intent.stale', 'intent.expired', 'receipt.issued')),
	CONSTRAINT "evidence_events_outcome_check" CHECK ("evidence_events"."outcome" in ('success', 'failure', 'denied')),
	CONSTRAINT "evidence_events_data_check" CHECK (jsonb_typeof("evidence_events"."data") = 'object' and octet_length("evidence_events"."data"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "evidence_payloads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"body" jsonb,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"erased_at" timestamp with time zone,
	CONSTRAINT "evidence_payloads_check" CHECK (("evidence_payloads"."body" is null) = ("evidence_payloads"."erased_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"intent_id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"client_id" text NOT NULL,
	"capability_identity" text NOT NULL,
	"capability_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"targets" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"plan" jsonb,
	"policy_class" text NOT NULL,
	"commit_token_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"receipt" jsonb,
	CONSTRAINT "intents_policy_class_check" CHECK ("intents"."policy_class" in ('agent', 'controlled', 'human')),
	CONSTRAINT "intents_commit_token_hash_check" CHECK ("intents"."commit_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "intents_status_check" CHECK ("intents"."status" in ('prepared', 'awaiting_approval', 'committing', 'committed', 'failed', 'expired', 'stale')),
	CONSTRAINT "intents_check" CHECK ("intents"."expires_at" > "intents"."created_at"),
	CONSTRAINT "intents_check1" CHECK (("intents"."status" = 'committed') = ("intents"."receipt" is not null))
);
--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_payload_ref_fkey" FOREIGN KEY ("payload_ref") REFERENCES "public"."evidence_payloads"("id") ON DELETE no action ON UPDATE no action;
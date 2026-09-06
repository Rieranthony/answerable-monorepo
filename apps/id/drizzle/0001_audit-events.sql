CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"organization_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"outcome" text NOT NULL,
	"reason" text,
	"request_id" text,
	"ip" text,
	"user_agent" text,
	"data" jsonb,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" in ('user', 'client', 'system')),
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" in ('success', 'failure', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_organization_id_id_idx" ON "audit_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events" USING btree ("target_type","target_id");
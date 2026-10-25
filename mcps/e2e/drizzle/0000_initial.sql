CREATE TABLE "e2e"."records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "e2e"."records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "e2e"."records" AS PERMISSIVE FOR ALL TO public USING ("e2e"."records"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid) WITH CHECK ("e2e"."records"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid);
CREATE TABLE "example"."notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "example"."notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "example"."notes" AS PERMISSIVE FOR ALL TO public USING ("example"."notes"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid) WITH CHECK ("example"."notes"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid);
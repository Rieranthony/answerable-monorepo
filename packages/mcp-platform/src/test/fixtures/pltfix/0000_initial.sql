CREATE TABLE "pltfix"."notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"title" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pltfix"."notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "pltfix"."notes" AS PERMISSIVE FOR ALL TO public USING ("pltfix"."notes"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid) WITH CHECK ("pltfix"."notes"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid);
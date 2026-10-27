CREATE TABLE "mpgfixb"."secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mpgfixb"."secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "mpgfixb"."secrets" AS PERMISSIVE FOR ALL TO public USING ("mpgfixb"."secrets"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid) WITH CHECK ("mpgfixb"."secrets"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid);
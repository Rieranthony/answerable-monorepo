CREATE TABLE "mpgfixa"."notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mpgfixa"."notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mpgfixa"."projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mpgfixa"."projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mpgfixa"."notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "mpgfixa"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "mpgfixa"."notes" AS PERMISSIVE FOR ALL TO public USING ("mpgfixa"."notes"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid) WITH CHECK ("mpgfixa"."notes"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organisation_isolation" ON "mpgfixa"."projects" AS PERMISSIVE FOR ALL TO public USING ("mpgfixa"."projects"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid) WITH CHECK ("mpgfixa"."projects"."organisation_id" = nullif(current_setting('answerable.organisation_id', true), '')::uuid);
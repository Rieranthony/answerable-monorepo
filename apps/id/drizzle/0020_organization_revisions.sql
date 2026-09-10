ALTER TABLE "organizations" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_revision_check" CHECK ("organizations"."revision" > 0);--> statement-breakpoint
CREATE TRIGGER organizations_revision_guard BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();

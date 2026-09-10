ALTER TABLE "members" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_revision_check" CHECK ("members"."revision" > 0);--> statement-breakpoint
CREATE TRIGGER members_revision_guard BEFORE UPDATE ON members
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();

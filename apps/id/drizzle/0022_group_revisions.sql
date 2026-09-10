ALTER TABLE "groups" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_revision_check" CHECK ("groups"."revision" > 0);--> statement-breakpoint
CREATE TRIGGER groups_revision_guard BEFORE UPDATE ON groups
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();

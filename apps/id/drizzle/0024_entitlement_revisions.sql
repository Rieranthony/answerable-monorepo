ALTER TABLE "entitlements" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_revision_check" CHECK ("entitlements"."revision" > 0);--> statement-breakpoint
CREATE TRIGGER entitlements_revision_guard BEFORE UPDATE ON entitlements
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();

ALTER TABLE "sso_providers" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_revision_check" CHECK ("sso_providers"."revision" > 0);--> statement-breakpoint
CREATE TRIGGER sso_providers_revision_guard BEFORE UPDATE ON sso_providers
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();

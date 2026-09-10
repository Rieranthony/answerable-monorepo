ALTER TABLE "oauth_resources" ADD COLUMN "classification" text DEFAULT 'platform_shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_resources" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_resources" ADD CONSTRAINT "oauth_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_resources_organization_id_idx" ON "oauth_resources" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "oauth_resources" ADD CONSTRAINT "oauth_resources_ownership_check" CHECK (("oauth_resources"."classification" = 'platform_shared' and "oauth_resources"."organization_id" is null) or ("oauth_resources"."classification" = 'tenant_owned' and "oauth_resources"."organization_id" is not null));
--> statement-breakpoint
CREATE FUNCTION protect_resource_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.classification IS DISTINCT FROM OLD.classification OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Resource ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER resource_ownership_immutable BEFORE UPDATE ON oauth_resources FOR EACH ROW EXECUTE FUNCTION protect_resource_ownership();

--> statement-breakpoint
CREATE FUNCTION protect_private_resource_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM oauth_resources r WHERE r.identifier = NEW.resource AND r.classification = 'tenant_owned' AND r.organization_id <> NEW.organization_id) THEN
    RAISE EXCEPTION 'Private resource belongs to another organisation' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER private_resource_assignment BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION protect_private_resource_assignment();

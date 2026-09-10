ALTER TABLE "oauth_resources" DROP CONSTRAINT "oauth_resources_identity_claims_check";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "authorization_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_authorization_version_check" CHECK ("organizations"."authorization_version" > 0);--> statement-breakpoint
ALTER TABLE "oauth_resources" ADD CONSTRAINT "oauth_resources_identity_claims_check" CHECK (NOT ("oauth_resources"."custom_claims" ?| ARRAY['client_instance', 'organization_id', 'authorization_version', 'organization_authorization_version', 'subject_type']));
--> statement-breakpoint
CREATE FUNCTION protect_organization_authorization_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.authorization_version < OLD.authorization_version THEN
    RAISE EXCEPTION 'Organization authorization version cannot decrease'
      USING ERRCODE = '23514', CONSTRAINT = 'organizations_version_monotonic';
  END IF;
  IF NEW.status = 'disabled' AND OLD.status <> 'disabled' THEN
    NEW.authorization_version := greatest(NEW.authorization_version, OLD.authorization_version + 1);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_authorization_version_guard BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION protect_organization_authorization_version();

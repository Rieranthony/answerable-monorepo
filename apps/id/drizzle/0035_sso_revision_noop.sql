-- Native SSO locks a provider with a same-value UPDATE. Timestamp-only changes
-- must not make an ordinary login look like a configuration replacement.
CREATE FUNCTION protect_sso_provider_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'Configuration revision is server controlled'
      USING ERRCODE = '23514', CONSTRAINT = 'configuration_revision_server_controlled';
  END IF;
  IF (to_jsonb(NEW) - 'revision' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revision' - 'updated_at') THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER sso_providers_revision_guard ON sso_providers;
--> statement-breakpoint
CREATE TRIGGER sso_providers_revision_guard BEFORE UPDATE ON sso_providers
FOR EACH ROW EXECUTE FUNCTION protect_sso_provider_revision();

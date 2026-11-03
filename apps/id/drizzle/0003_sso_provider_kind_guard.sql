-- Reviewed by hand. Sessions and grants name a provider row, and its kind decides what they
-- hold, so a row's kind never changes. The trigger fires before sso_providers_revision_guard
-- (triggers fire in name order), so a refused change never reaches the revision.
CREATE FUNCTION protect_sso_provider_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'A provider''s kind is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'sso_providers_kind_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sso_providers_kind_guard BEFORE UPDATE ON sso_providers
FOR EACH ROW EXECUTE FUNCTION protect_sso_provider_kind();

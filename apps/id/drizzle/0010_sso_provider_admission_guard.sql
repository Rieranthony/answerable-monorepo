-- Reviewed by hand. Sessions and grants name a provider row and its revision, so anything
-- that moves the revision ends them. `admission` says who may ask for a link next: narrowing
-- it leaves members as members, and widening it takes nothing from anyone, so changing it
-- must end no session and no grant.
--
-- It cannot join `updated_at` in protect_configuration_revision's arguments. That function
-- answers a change to ignored columns alone with NEW := OLD, so an update of `admission` would
-- report success and store nothing. This one does what that one does for every other column,
-- and keeps a change to `admission` without moving the revision. The previous image never
-- writes `admission`, so it runs as before. The trigger keeps its name, since triggers fire in
-- name order and `sso_providers_kind_guard` and `sso_providers_platform_magic_link` must still
-- fire first.
CREATE FUNCTION protect_sso_provider_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'Configuration revision is server controlled'
      USING ERRCODE = '23514', CONSTRAINT = 'configuration_revision_server_controlled';
  END IF;
  IF (to_jsonb(NEW) - 'revision' - 'updated_at' - 'admission') IS DISTINCT FROM (to_jsonb(OLD) - 'revision' - 'updated_at' - 'admission') THEN
    NEW.revision := OLD.revision + 1;
  ELSIF NEW.admission IS NOT DISTINCT FROM OLD.admission THEN
    NEW := OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER sso_providers_revision_guard ON sso_providers;
--> statement-breakpoint
CREATE TRIGGER sso_providers_revision_guard BEFORE UPDATE ON sso_providers
FOR EACH ROW EXECUTE FUNCTION protect_sso_provider_revision();

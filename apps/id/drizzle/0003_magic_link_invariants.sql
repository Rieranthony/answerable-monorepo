-- Reviewed by hand, as 0001_invariants.sql is: what the schema modules cannot express about
-- magic links. Triggers on sso_providers fire in name order, so `sso_providers_kind_guard` and
-- `sso_providers_platform_magic_link` both fire before `sso_providers_revision_guard`, and a
-- refused change never reaches the revision.

-- Sessions and grants name a provider row, and its kind decides what they hold, so a row's kind
-- never changes.
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
--> statement-breakpoint
-- Every live organisation holds one magic-link provider row, whoever creates it, and it starts
-- off: staff turn a firm's links on. The platform organisation's can never be on.
--
-- The triggers go in before the backfill. CREATE TRIGGER waits for writers and blocks new ones
-- until this transaction commits, so an organisation or a binding made during the migration is
-- either committed and seen by the backfill, or fires the trigger afterwards.
--
-- What createId() mints, for the rows a trigger creates: `id` columns have no default, so that a
-- raw insert cannot mint a UUIDv4.
CREATE FUNCTION uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(
    set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
      PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
      FROM 1 FOR 6), 52, 1), 53, 1),
    'hex')::uuid
$$;
--> statement-breakpoint
-- SECURITY DEFINER: an organisation is created with no write scope on providers (bootstrap
-- inserts the platform organisation before it sets one), and RLS refuses an invoker's insert.
-- `enabled` is named: the column's default is true, because sso_providers_enabled_check requires
-- it of a directory's row, and every directory insert leaves it to the default.
CREATE FUNCTION create_magic_link_provider() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.sso_providers (id, organization_id, kind, provider_id, issuer, domain, enabled)
  VALUES (public.uuid_v7(), NEW.id, 'magic_link', 'magic-link:' || NEW.id::text, 'urn:answerable:magic-link', 'magic-link.invalid', false);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_magic_link_provider AFTER INSERT ON organizations
FOR EACH ROW WHEN (NEW.deleted_at IS NULL) EXECUTE FUNCTION create_magic_link_provider();
--> statement-breakpoint
-- The platform organisation can never use magic links, on any connection.
CREATE FUNCTION protect_platform_magic_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.system_bindings b WHERE b.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'The platform organisation cannot use magic links'
      USING ERRCODE = '23514', CONSTRAINT = 'sso_providers_platform_magic_link';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sso_providers_platform_magic_link BEFORE INSERT OR UPDATE ON sso_providers
FOR EACH ROW WHEN (NEW.kind = 'magic_link' AND NEW.enabled) EXECUTE FUNCTION protect_platform_magic_link();
--> statement-breakpoint
-- An organisation whose links were turned on before it was bound as the platform's has them
-- turned off here. SECURITY DEFINER: RLS filters an invoker's update to no rows without an
-- error, which would leave the row on.
CREATE FUNCTION disable_platform_magic_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.sso_providers SET enabled = false, updated_at = statement_timestamp()
  WHERE organization_id = NEW.organization_id AND kind = 'magic_link' AND deleted_at IS NULL AND enabled;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER system_bindings_magic_link AFTER INSERT ON system_bindings
FOR EACH ROW EXECUTE FUNCTION disable_platform_magic_link();
--> statement-breakpoint
-- Run by the schema owner, which RLS does not bind: no table here forces it.
INSERT INTO sso_providers (id, organization_id, kind, provider_id, issuer, domain, enabled)
SELECT uuid_v7(), o.id, 'magic_link', 'magic-link:' || o.id::text, 'urn:answerable:magic-link', 'magic-link.invalid', false
FROM organizations o
WHERE o.deleted_at IS NULL;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION uuid_v7(), create_magic_link_provider(), disable_platform_magic_link() FROM PUBLIC;
--> statement-breakpoint
-- A session names a provider row and revision, and nothing that grants authority reads
-- `enabled`, so a session at an off row's current revision would have standing. This refuses to
-- make one, on any connection. `FOR SHARE` waits for a command changing the row, then reads what
-- it committed, so a sign-in racing a switch-off cannot get past it. A directory row is always
-- enabled (sso_providers_enabled_check), so only the kind this names is affected.
CREATE OR REPLACE FUNCTION protect_session_authentication_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.user_id, NEW.created_at, NEW.authentication_organization_id, NEW.authentication_provider_id, NEW.authentication_provider_revision, NEW.authentication_account_id, NEW.upstream_auth_time)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.created_at, OLD.authentication_organization_id, OLD.authentication_provider_id, OLD.authentication_provider_revision, OLD.authentication_account_id, OLD.upstream_auth_time) THEN
      RAISE EXCEPTION 'Session identity and authentication origin are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_immutable';
    END IF;
  ELSIF NEW.authentication_provider_id IS NOT NULL THEN
    PERFORM 1 FROM public.sso_providers p
      JOIN public.accounts a ON a.id = NEW.authentication_account_id
        AND a.user_id = NEW.user_id AND a.issuer = p.issuer
        AND a.provider_id = p.provider_id AND a.deleted_at IS NULL
      WHERE p.id = NEW.authentication_provider_id
        AND p.organization_id = NEW.authentication_organization_id
        AND p.revision = NEW.authentication_provider_revision AND p.deleted_at IS NULL
        AND (p.kind <> 'magic_link' OR p.enabled)
      FOR SHARE OF p, a;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session authentication origin must match its provider and account'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_provider';
    END IF;
  ELSIF NEW.authentication_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Session account requires an authentication provider'
      USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_provider';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Sessions and grants name a provider row and its revision, so anything that moves the revision
-- ends them. `admission` says who may ask for a link next: narrowing it leaves members as members,
-- and widening it takes nothing from anyone, so changing it must end no session and no grant.
--
-- It cannot join `updated_at` in protect_configuration_revision's arguments. That function
-- answers a change to ignored columns alone with NEW := OLD, so an update of `admission` would
-- report success and store nothing. This one does what that one does for every other column, and
-- keeps a change to `admission` without moving the revision. The trigger keeps its name, since
-- triggers fire in name order.
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

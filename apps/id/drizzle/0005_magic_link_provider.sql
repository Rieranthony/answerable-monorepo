-- Reviewed by hand. Every live organisation holds one magic-link provider row, whoever
-- creates it, and the platform organisation's is always off. The previous image was built
-- to be safe on these rows: it reads the directory by kind and refuses a magic-link session.
--
-- The triggers go in before the backfill. CREATE TRIGGER waits for writers and blocks new
-- ones until this transaction commits, so an organisation or a binding made during the
-- migration is either committed and seen by the backfill, or fires the trigger afterwards.
--
-- What createId() mints, for the rows a trigger creates: `id` columns have no default, so
-- that a raw insert cannot mint a UUIDv4.
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
CREATE FUNCTION create_magic_link_provider() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.sso_providers (id, organization_id, kind, provider_id, issuer, domain)
  VALUES (public.uuid_v7(), NEW.id, 'magic_link', 'magic-link:' || NEW.id::text, 'urn:answerable:magic-link', 'magic-link.invalid');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_magic_link_provider AFTER INSERT ON organizations
FOR EACH ROW WHEN (NEW.deleted_at IS NULL) EXECUTE FUNCTION create_magic_link_provider();
--> statement-breakpoint
-- The platform organisation can never use magic links, on any connection. The trigger fires
-- before sso_providers_revision_guard (triggers fire in name order), so a refused change
-- never reaches the revision.
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
-- Bootstrap inserts the organisation first, so its row starts on and goes off here.
-- SECURITY DEFINER: RLS filters an invoker's update to no rows without an error, which would
-- leave the row on.
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
SELECT uuid_v7(), o.id, 'magic_link', 'magic-link:' || o.id::text, 'urn:answerable:magic-link', 'magic-link.invalid',
  NOT EXISTS (SELECT 1 FROM system_bindings b WHERE b.organization_id = o.id)
FROM organizations o
WHERE o.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM sso_providers p WHERE p.organization_id = o.id AND p.kind = 'magic_link' AND p.deleted_at IS NULL);
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION uuid_v7(), create_magic_link_provider(), disable_platform_magic_link() FROM PUBLIC;

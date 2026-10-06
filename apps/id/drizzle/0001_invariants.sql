-- Database invariants, reviewed by hand. 0000_initial.sql is untouched drizzle-kit output;
-- this file adds what drizzle-orm 0.45.2 cannot express in the schema modules: the deferrable
-- audit-to-operation foreign key, NULLS NOT DISTINCT on two partial unique indexes, and the
-- functions, triggers and execution grants. `bun run db:regenerate` keeps this file.
-- The live foreign keys, `(parent_id, live)` onto a parent's `unique (id, live)`, are in
-- 0000: drizzle-kit orders them correctly from an empty snapshot. An incremental migration
-- that adds one to an existing table emits the foreign key before its unique constraint,
-- which Postgres refuses (42830); move the unique constraint first by hand.
ALTER TABLE "audit_events" ALTER CONSTRAINT "audit_events_operation_id_admin_operations_id_fk" DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
DROP INDEX "entitlements_principal_target_unique";
--> statement-breakpoint
-- Drizzle does not model NULLS NOT DISTINCT on partial indexes. Preserve null-target uniqueness.
CREATE UNIQUE INDEX "entitlements_principal_target_unique" ON "entitlements" USING btree ("organization_id","member_id","group_id","client_id","resource") NULLS NOT DISTINCT WHERE "entitlements"."deleted_at" is null;
--> statement-breakpoint
DROP INDEX "organization_capabilities_target_kind_unique";
--> statement-breakpoint
-- The bound platform ceiling must remain unique even with a null client.
CREATE UNIQUE INDEX "organization_capabilities_target_kind_unique" ON "organization_capabilities" USING btree ("organization_id","client_id","resource","grant_kind") NULLS NOT DISTINCT WHERE "organization_capabilities"."deleted_at" is null;
--> statement-breakpoint
CREATE FUNCTION protect_oauth_client_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Client identity and ownership are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_clients_identity_immutable';
  END IF;
  IF NEW.authorization_version < OLD.authorization_version THEN
    RAISE EXCEPTION 'Client authorization version cannot decrease'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_clients_version_monotonic';
  END IF;
  IF NEW.client_secret IS DISTINCT FROM OLD.client_secret
     OR NEW.jwks IS DISTINCT FROM OLD.jwks
     OR NEW.jwks_uri IS DISTINCT FROM OLD.jwks_uri
     OR NEW.token_endpoint_auth_method IS DISTINCT FROM OLD.token_endpoint_auth_method
     OR (NEW.disabled AND NOT OLD.disabled) THEN
    NEW.authorization_version := greatest(NEW.authorization_version, OLD.authorization_version + 1);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_oauth_resource_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.identifier IS DISTINCT FROM OLD.identifier THEN
    RAISE EXCEPTION 'Resource identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_resources_identity_immutable';
  END IF;
  IF NEW.classification IS DISTINCT FROM OLD.classification OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Resource ownership is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_resources_ownership_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION try_uuid(value text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- The users an audit event concerns: a user actor or target, the user behind a member,
-- group-member or session target or a member entitlement, and the users the action's
-- manifests name.
CREATE FUNCTION capture_audit_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.audit_event_users (user_id, event_id)
  SELECT DISTINCT subject.user_id, NEW.id FROM (
    SELECT public.try_uuid(NEW.actor_id) WHERE NEW.actor_type = 'user'
    UNION ALL SELECT public.try_uuid(NEW.target_id) WHERE NEW.target_type = 'user'
    UNION ALL SELECT m.user_id FROM public.members m
      WHERE NEW.target_type IN ('member', 'group_member') AND m.id = public.try_uuid(NEW.target_id)
    UNION ALL SELECT m.user_id FROM public.members m
      WHERE NEW.target_type = 'entitlement'
        AND m.id = public.try_uuid(coalesce(NEW.data->'after'->>'memberId', NEW.data->'before'->>'memberId'))
    UNION ALL SELECT coalesce(
        (SELECT s.user_id FROM public.sessions s WHERE s.id = public.try_uuid(NEW.target_id)),
        public.try_uuid(NEW.data->>'userId'))
      WHERE NEW.target_type = 'session'
    UNION ALL SELECT public.try_uuid(entry->>'userId')
      FROM (VALUES
        ('user.erased', '{effects,deletedAccessTokens}'::text[]),
        ('user.erased', '{effects,deletedRefreshTokens}'),
        ('user.erased', '{effects,softDeletedConsents}'),
        ('user.erased', '{effects,clearedAccessTokenSessions}'),
        ('user.erased', '{effects,clearedRefreshTokenSessions}'),
        ('organization.disabled', '{effects,revokedGrantContexts}'),
        ('organization.erased', '{revokedGrantContexts}'),
        ('organization.erased', '{effects,softDeletedMembers}'),
        ('group.enabled', '{policySources,assignments}'),
        ('group.disabled', '{policySources,assignments}'),
        ('group.erased', '{effects,softDeletedAssignments}'),
        ('entitlement.created', '{audience}'),
        ('entitlement.updated', '{audience}'),
        ('entitlement.enabled', '{audience}'),
        ('entitlement.disabled', '{audience}'),
        ('entitlement.removed', '{audience}'),
        ('client.grants_revoked', '{grantContexts}'),
        ('client.grants_revoked', '{revokedTokens,access}'),
        ('client.grants_revoked', '{revokedTokens,refresh}'),
        ('client.grants_erased', '{grantContexts}'),
        ('client.grants_erased', '{effects,deletedAccessTokens}'),
        ('client.grants_erased', '{effects,deletedRefreshTokens}'),
        ('client.grants_erased', '{effects,softDeletedConsents}'),
        ('resource.disabled', '{effects,revokedGrantContexts}'),
        ('resource.erased', '{revokedGrantContexts}'),
        ('sso_provider.created', '{effects,revokedGrantContexts}'),
        ('sso_provider.updated', '{effects,revokedGrantContexts}'),
        ('sso_provider.deleted', '{effects,revokedGrantContexts}')
      ) AS manifest(action, path)
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.data #> manifest.path) = 'array'
        THEN NEW.data #> manifest.path ELSE '[]'::jsonb END) AS entries(entry)
      WHERE manifest.action = NEW.action
  ) AS subject(user_id)
  WHERE subject.user_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Columns named as trigger arguments do not count as a change: an update of only those
-- keeps the revision and their old values (Better Auth locks an SSO provider that way).
CREATE FUNCTION protect_configuration_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ignored text[] := coalesce(TG_ARGV, '{}');
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'Configuration revision is server controlled'
      USING ERRCODE = '23514', CONSTRAINT = 'configuration_revision_server_controlled';
  END IF;
  IF (to_jsonb(NEW) - 'revision' - ignored) IS DISTINCT FROM (to_jsonb(OLD) - 'revision' - ignored) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW := OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION touch_client_resource_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.client_id = OLD.client_id AND NEW.resource = OLD.resource AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  FOR target IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.client_id END, NEW.client_id
    ]) AS targets(value) WHERE value IS NOT NULL ORDER BY value
  LOOP
    UPDATE public.oauth_clients
    SET updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE client_id = target;
  END LOOP;
  FOR target IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.resource END, NEW.resource
    ]) AS targets(value) WHERE value IS NOT NULL ORDER BY value
  LOOP
    UPDATE public.oauth_resources
    SET updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE identifier = target;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_member_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Membership identity and tenant are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'members_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_organization_authorization_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
CREATE FUNCTION protect_group_assignment_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    RAISE EXCEPTION 'Group assignment identity and ownership are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'group_members_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_private_resource_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.oauth_resources r WHERE r.identifier = NEW.resource AND r.classification = 'tenant_owned' AND r.organization_id <> NEW.organization_id) THEN
    RAISE EXCEPTION 'Private resource belongs to another organisation' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_capability_target() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.resource IS DISTINCT FROM OLD.resource OR NEW.grant_kind IS DISTINCT FROM OLD.grant_kind) THEN
    RAISE EXCEPTION 'Capability identity and target are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.grant_kind = 'admin_session' AND NOT EXISTS (SELECT 1 FROM public.system_bindings b JOIN public.oauth_resources r ON r.id = b.resource_instance_id WHERE r.identifier = NEW.resource) THEN
    RAISE EXCEPTION 'Direct administration requires the bound admin resource' USING ERRCODE = '23514';
  END IF;
  IF NEW.grant_kind = 'client_credentials' AND NOT EXISTS (SELECT 1 FROM public.oauth_clients c WHERE c.client_id = NEW.client_id AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Machine capability requires the owning tenant' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.scopes) s WHERE s LIKE 'platform:%') AND NOT EXISTS (SELECT 1 FROM public.system_bindings b WHERE b.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Platform scopes require the bound platform organisation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The fixed provenance guard must lock members without granting admission callers UPDATE.
-- Callers already hold the user, organisation, client and resource locks.
CREATE FUNCTION protect_grant_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'revoked_at' - 'authorization_code_id') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'authorization_code_id')
      OR (OLD.authorization_code_id IS NOT NULL AND NEW.authorization_code_id IS DISTINCT FROM OLD.authorization_code_id)
      OR (OLD.revoked_at IS NOT NULL AND NEW.authorization_code_id IS DISTINCT FROM OLD.authorization_code_id)
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
      RAISE EXCEPTION 'Grant context is immutable and revocation is irreversible'
        USING ERRCODE = '23514', CONSTRAINT = 'grant_context_immutable';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.members m
    JOIN public.organizations o ON o.id = m.organization_id
    JOIN public.users u ON u.id = m.user_id
    JOIN public.sessions s ON s.user_id = u.id
    JOIN public.oauth_clients c ON c.id = NEW.client_instance_id
    WHERE m.id = NEW.member_id AND m.organization_id = NEW.organization_id
      AND m.user_id = NEW.user_id AND m.status = 'active'
      AND o.status = 'active' AND u.status = 'active' AND m.deleted_at IS NULL AND o.deleted_at IS NULL AND u.deleted_at IS NULL AND c.deleted_at IS NULL
      AND s.id = NEW.authentication_session_id AND s.created_at = NEW.auth_time
      AND s.expires_at > statement_timestamp() AND c.disabled = false
      AND s.authentication_organization_id = NEW.organization_id
      AND s.authentication_account_id = NEW.authentication_account_id
      AND s.authentication_provider_id = NEW.authentication_provider_id
      AND s.authentication_provider_revision = NEW.authentication_provider_revision
      AND s.upstream_auth_time IS NOT DISTINCT FROM NEW.upstream_auth_time
      AND NEW.requested_scopes <@ c.scopes
    FOR SHARE OF m, s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grant authentication and membership must match'
      USING ERRCODE = '23514', CONSTRAINT = 'grant_context_provenance';
  END IF;
  IF NEW.resource_instance_id IS NOT NULL THEN
    PERFORM 1 FROM public.oauth_resources r WHERE r.id = NEW.resource_instance_id
      AND r.disabled = false AND r.deleted_at IS NULL
      AND (r.classification = 'platform_shared' OR r.organization_id = NEW.organization_id)
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Grant resource must be available to its tenant'
        USING ERRCODE = '23514', CONSTRAINT = 'grant_context_resource';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_soft_deletion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Product deletion is terminal' USING ERRCODE = '23514', CONSTRAINT = 'product_deletion_terminal';
  END IF;
  NEW.live := CASE WHEN NEW.deleted_at IS NULL THEN true END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_session_authentication_origin() RETURNS trigger
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
-- A user OAuth audit row names a real grant of its organisation and actor; its user is the subject.
CREATE FUNCTION record_user_oauth_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE g public.grant_contexts; public_client text;
BEGIN
  IF NEW.action NOT IN (
    'oauth.user.authorized', 'oauth.user.denied', 'oauth.user.issued', 'oauth.user.replayed', 'oauth.user.revoked'
  ) THEN RETURN NEW; END IF;
  SELECT * INTO g FROM public.grant_contexts WHERE id = public.try_uuid(NEW.target_id);
  SELECT client_id INTO public_client FROM public.oauth_clients WHERE id = g.client_instance_id;
  IF g.id IS NULL OR NEW.target_type <> 'grant_context' OR NEW.organization_id IS DISTINCT FROM g.organization_id
    OR NOT ((NEW.actor_type = 'user' AND NEW.actor_id = g.user_id::text) OR (NEW.actor_type = 'client' AND NEW.actor_id = public_client)) THEN
    RAISE EXCEPTION 'Invalid user OAuth outcome' USING ERRCODE = '23514', CONSTRAINT = 'user_oauth_audit_provenance';
  END IF;
  INSERT INTO public.audit_event_users (user_id, event_id) VALUES (g.user_id, NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_clients_identity_guard BEFORE UPDATE ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION protect_oauth_client_identity();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_identity_guard BEFORE UPDATE ON oauth_resources
FOR EACH ROW EXECUTE FUNCTION protect_oauth_resource_identity();
--> statement-breakpoint
CREATE TRIGGER audit_events_capture_subjects AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION capture_audit_subjects();
--> statement-breakpoint
CREATE TRIGGER oauth_clients_revision_guard BEFORE UPDATE ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER oauth_client_resources_revision AFTER INSERT OR UPDATE ON oauth_client_resources
FOR EACH ROW EXECUTE FUNCTION touch_client_resource_revision();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_revision_guard BEFORE UPDATE ON oauth_resources
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER members_identity_guard BEFORE UPDATE ON members
FOR EACH ROW EXECUTE FUNCTION protect_member_identity();
--> statement-breakpoint
CREATE TRIGGER organizations_authorization_version_guard BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION protect_organization_authorization_version();
--> statement-breakpoint
CREATE TRIGGER members_revision_guard BEFORE UPDATE ON members
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER organizations_revision_guard BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER sso_providers_revision_guard BEFORE UPDATE ON sso_providers
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision('updated_at');
--> statement-breakpoint
CREATE TRIGGER groups_revision_guard BEFORE UPDATE ON groups
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER group_members_identity_guard BEFORE UPDATE ON group_members
FOR EACH ROW EXECUTE FUNCTION protect_group_assignment_identity();
--> statement-breakpoint
CREATE TRIGGER group_members_revision_guard BEFORE UPDATE ON group_members
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER entitlements_revision_guard BEFORE UPDATE ON entitlements
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER private_resource_assignment BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION protect_private_resource_assignment();
--> statement-breakpoint
CREATE TRIGGER capability_target_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_capability_target();
--> statement-breakpoint
CREATE TRIGGER capability_private_resource_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_private_resource_assignment();
--> statement-breakpoint
CREATE TRIGGER capability_revision_guard BEFORE UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER grant_context_guard BEFORE INSERT OR UPDATE ON grant_contexts
FOR EACH ROW EXECUTE FUNCTION protect_grant_context();
--> statement-breakpoint
CREATE TRIGGER sessions_authentication_origin_guard BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION protect_session_authentication_origin();
--> statement-breakpoint
CREATE TRIGGER users_deletion_guard BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER organizations_deletion_guard BEFORE INSERT OR UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER accounts_deletion_guard BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER members_deletion_guard BEFORE INSERT OR UPDATE ON members FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER organization_domains_deletion_guard BEFORE INSERT OR UPDATE ON organization_domains FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER groups_deletion_guard BEFORE INSERT OR UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER group_members_deletion_guard BEFORE INSERT OR UPDATE ON group_members FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER entitlements_deletion_guard BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_clients_deletion_guard BEFORE INSERT OR UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_deletion_guard BEFORE INSERT OR UPDATE ON oauth_resources FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_client_resources_deletion_guard BEFORE INSERT OR UPDATE ON oauth_client_resources FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_consents_deletion_guard BEFORE INSERT OR UPDATE ON oauth_consents FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER sso_providers_deletion_guard BEFORE INSERT OR UPDATE ON sso_providers FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER organization_capabilities_deletion_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_soft_deletion();
--> statement-breakpoint
CREATE TRIGGER audit_events_user_oauth_subjects AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION record_user_oauth_subjects();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION protect_grant_context(), capture_audit_subjects(), record_user_oauth_subjects() FROM PUBLIC;

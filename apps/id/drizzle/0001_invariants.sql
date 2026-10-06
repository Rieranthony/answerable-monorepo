-- Database invariants, reviewed by hand. 0000_initial.sql is untouched drizzle-kit output;
-- this file adds what drizzle-orm 0.45.2 cannot express in the schema modules: the deferrable
-- audit-to-operation foreign key, NULLS NOT DISTINCT on two partial unique indexes, and the
-- functions, triggers and execution grants. `bun run db:regenerate` keeps this file.
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
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.identifier IS DISTINCT FROM OLD.identifier THEN
    RAISE EXCEPTION 'Resource identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_resources_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_system_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'System bindings are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'system_bindings_immutable';
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
CREATE FUNCTION capture_audit_subjects(event public.audit_events, origin text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE related_user text; user_effects jsonb; entitlement_state jsonb;
BEGIN
  INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
  VALUES (event.id, event.actor_type, event.actor_id, 'actor', event.organization_id, origin);
  IF event.target_id IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, event.target_type, event.target_id, 'target', event.organization_id, origin);
  END IF;
  IF event.target_type = 'entitlement' THEN
    entitlement_state := CASE WHEN event.action = 'entitlement.created'
      THEN event.data->'after' ELSE event.data->'before' END;
  END IF;
  IF event.target_type IN ('member', 'group_member') THEN
    SELECT user_id::text INTO related_user FROM public.members
    WHERE id = public.try_uuid(event.target_id) AND (event.organization_id IS NULL OR organization_id = event.organization_id);
    related_user := coalesce(related_user, event.data->>'userId');
  ELSIF (event.schema_version = 1 OR (event.schema_version = 3 AND event.action = 'entitlement.removed' AND event.data->>'deletionMode' = 'soft')) AND event.outcome = 'success'
    AND event.organization_id IS NOT NULL AND event.target_type = 'entitlement'
    AND event.target_id IS NOT NULL AND event.action IN (
      'entitlement.created', 'entitlement.updated', 'entitlement.update_unchanged',
      'entitlement.enabled', 'entitlement.disabled', 'entitlement.enable_unchanged',
      'entitlement.disable_unchanged', 'entitlement.removed'
    ) THEN
    SELECT user_id::text INTO related_user FROM public.members
    WHERE id = public.try_uuid(entitlement_state->>'memberId')
      AND organization_id = event.organization_id
      AND entitlement_state->>'organizationId' = event.organization_id::text
      AND entitlement_state->>'id' = event.target_id;
  ELSIF event.target_type = 'session' THEN
    SELECT user_id::text INTO related_user FROM public.sessions WHERE id = public.try_uuid(event.target_id);
    related_user := coalesce(related_user, event.data->>'userId');
  END IF;
  IF related_user IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, 'user', related_user, 'affected', event.organization_id, origin);
  END IF;
  user_effects := CASE
    WHEN event.schema_version = 3 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NULL AND event.target_type = 'user' AND event.action = 'user.erased'
      AND event.data->'before'->>'id' = event.target_id AND event.data->'after'->>'id' = event.target_id
      AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN (CASE WHEN jsonb_typeof(event.data->'revokedGrantContexts') = 'array' THEN event.data->'revokedGrantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedAccessTokens') = 'array' THEN event.data->'effects'->'deletedAccessTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedRefreshTokens') = 'array' THEN event.data->'effects'->'deletedRefreshTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'softDeletedConsents') = 'array' THEN event.data->'effects'->'softDeletedConsents' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedAccessTokenSessions') = 'array' THEN event.data->'effects'->'clearedAccessTokenSessions' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedRefreshTokenSessions') = 'array' THEN event.data->'effects'->'clearedRefreshTokenSessions' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 3 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NOT NULL AND event.target_type = 'organization' AND event.action = 'organization.erased'
      AND event.target_id = event.organization_id::text AND event.data->'after'->>'id' = event.target_id
      AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN (CASE WHEN jsonb_typeof(event.data->'revokedGrantContexts') = 'array' THEN event.data->'revokedGrantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'softDeletedMembers') = 'array' THEN event.data->'effects'->'softDeletedMembers' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedSessionSelections') = 'array' THEN event.data->'effects'->'clearedSessionSelections' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 3 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NOT NULL AND event.target_type = 'group' AND event.action = 'group.erased'
      AND event.data->'after'->>'id' = event.target_id AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN event.data->'effects'->'softDeletedAssignments'
    WHEN event.schema_version = 3 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NULL AND event.target_type = 'client' AND event.action = 'client.grants_erased'
      AND event.target_id IS NOT NULL AND jsonb_typeof(event.data->'clientInstanceId') = 'string'
      AND event.data->>'clientInstanceId' <> ''
      THEN (CASE WHEN jsonb_typeof(event.data->'grantContexts') = 'array' THEN event.data->'grantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedAccessTokens') = 'array' THEN event.data->'effects'->'deletedAccessTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedRefreshTokens') = 'array' THEN event.data->'effects'->'deletedRefreshTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'softDeletedConsents') = 'array' THEN event.data->'effects'->'softDeletedConsents' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 2 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NULL AND event.target_type = 'resource' AND event.action = 'resource.erased'
      AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN event.data->'revokedGrantContexts'
    WHEN event.schema_version = 2 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NOT NULL AND event.target_type = 'sso_provider' AND event.action = 'sso_provider.deleted'
      AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN event.data->'effects'->'revokedGrantContexts'
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NULL AND event.target_type = 'user'
      AND event.target_id IS NOT NULL AND event.action = 'user.erased'
      AND event.data->'before'->>'id' = event.target_id
      THEN
        (CASE WHEN jsonb_typeof(event.data->'deletedGrantContexts') = 'array' THEN event.data->'deletedGrantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedAccessTokens') = 'array' THEN event.data->'effects'->'deletedAccessTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedRefreshTokens') = 'array' THEN event.data->'effects'->'deletedRefreshTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedConsents') = 'array' THEN event.data->'effects'->'deletedConsents' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedAccessTokenSessions') = 'array' THEN event.data->'effects'->'clearedAccessTokenSessions' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedRefreshTokenSessions') = 'array' THEN event.data->'effects'->'clearedRefreshTokenSessions' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NOT NULL AND event.target_type = 'organization'
      AND event.target_id = event.organization_id::text AND event.action = 'organization.erased'
      THEN
        (CASE WHEN jsonb_typeof(event.data->'effects'->'removedMembers') = 'array'
          THEN event.data->'effects'->'removedMembers' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedSessionSelections') = 'array'
          THEN event.data->'effects'->'clearedSessionSelections' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'deletedGrantContexts') = 'array'
          THEN event.data->'deletedGrantContexts' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NOT NULL AND event.target_type = 'group'
      AND event.target_id IS NOT NULL AND event.action = 'group.erased'
      THEN event.data->'effects'->'removedAssignments'
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NOT NULL AND event.target_type = 'group'
      AND event.target_id IS NOT NULL AND event.action IN ('group.enabled', 'group.disabled')
      THEN event.data->'policySources'->'assignments'
    WHEN (event.schema_version = 2 OR (event.schema_version = 3 AND event.action = 'entitlement.removed' AND event.data->>'deletionMode' = 'soft')) AND event.outcome = 'success'
      AND event.organization_id IS NOT NULL AND event.target_type = 'entitlement'
      AND event.target_id IS NOT NULL AND event.action IN (
        'entitlement.created', 'entitlement.updated', 'entitlement.enabled',
        'entitlement.disabled', 'entitlement.removed'
      )
      AND entitlement_state->>'id' = event.target_id
      AND entitlement_state->>'organizationId' = event.organization_id::text
      AND entitlement_state->'memberId' = 'null'::jsonb
      AND jsonb_typeof(entitlement_state->'groupId') IN ('null', 'string')
      THEN event.data->'audience'
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NULL AND event.target_type = 'client'
      AND event.target_id IS NOT NULL AND event.action = 'client.grants_revoked'
      AND jsonb_typeof(event.data->'clientInstanceId') = 'string'
      AND event.data->>'clientInstanceId' <> ''
      THEN
        (CASE WHEN jsonb_typeof(event.data->'grantContexts') = 'array' THEN event.data->'grantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'revokedTokens'->'access') = 'array' THEN event.data->'revokedTokens'->'access' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'revokedTokens'->'refresh') = 'array' THEN event.data->'revokedTokens'->'refresh' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NULL AND event.target_type = 'client'
      AND event.target_id IS NOT NULL AND event.action = 'client.grants_erased'
      AND jsonb_typeof(event.data->'clientInstanceId') = 'string'
      AND event.data->>'clientInstanceId' <> ''
      THEN
        (CASE WHEN jsonb_typeof(event.data->'grantContexts') = 'array' THEN event.data->'grantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedAccessTokens') = 'array' THEN event.data->'effects'->'deletedAccessTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedRefreshTokens') = 'array' THEN event.data->'effects'->'deletedRefreshTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedConsents') = 'array' THEN event.data->'effects'->'deletedConsents' ELSE '[]'::jsonb END)
    WHEN event.schema_version <> 1 OR event.outcome <> 'success' THEN '[]'::jsonb
    WHEN event.organization_id IS NULL AND event.target_type = 'user' AND event.action = 'user.erased'
      THEN event.data->'deletedGrantContexts'
    WHEN event.organization_id IS NULL AND event.target_type = 'client'
      AND event.action IN ('client.grants_revoked', 'client.grants_erased')
      THEN event.data->'grantContexts'
    WHEN event.organization_id IS NULL AND event.target_type = 'resource' AND event.action = 'resource.disabled'
      THEN event.data->'effects'->'revokedGrantContexts'
    WHEN event.organization_id IS NULL AND event.target_type = 'resource' AND event.action = 'resource.erased'
      THEN event.data->'deletedGrantContexts'
    WHEN event.organization_id IS NOT NULL AND event.target_type = 'organization'
      AND event.target_id = event.organization_id::text AND event.action = 'organization.disabled'
      THEN event.data->'effects'->'revokedGrantContexts'
    WHEN event.organization_id IS NOT NULL AND event.target_type = 'organization'
      AND event.target_id = event.organization_id::text AND event.action = 'organization.erased'
      THEN event.data->'deletedGrantContexts'
    WHEN event.organization_id IS NOT NULL AND event.target_type = 'sso_provider'
      AND event.action IN ('sso_provider.created', 'sso_provider.updated', 'sso_provider.deleted')
      THEN event.data->'effects'->'revokedGrantContexts'
    ELSE '[]'::jsonb
  END;
  IF jsonb_typeof(user_effects) = 'array' THEN
    INSERT INTO public.audit_event_subjects
      (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    SELECT DISTINCT event.id, 'user', effect->>'userId', 'affected', event.organization_id, origin
    FROM jsonb_array_elements(user_effects) AS effects(effect)
    WHERE jsonb_typeof(effect->'userId') = 'string' AND effect->>'userId' <> ''
      AND (event.schema_version NOT IN (2, 3) OR event.target_type NOT IN ('user', 'client') OR (
        jsonb_typeof(effect->'id') = 'string' AND effect->>'id' <> ''
      ))
      AND (event.schema_version NOT IN (2, 3) OR event.target_type <> 'organization' OR (
        effect->>'organizationId' = event.organization_id::text
        AND jsonb_typeof(effect->'id') = 'string' AND effect->>'id' <> ''
      ))
      AND (event.action NOT IN ('group.erased', 'group.enabled', 'group.disabled') OR (
        effect->>'organizationId' = event.organization_id::text
        AND effect->>'groupId' = event.target_id
      ))
      AND (event.target_type <> 'entitlement' OR (
        effect->>'organizationId' = event.organization_id::text
        AND jsonb_typeof(effect->'memberId') = 'string' AND effect->>'memberId' <> ''
        AND (
          (entitlement_state->'groupId' = 'null'::jsonb AND effect->'groupAssignment' = 'null'::jsonb)
          OR (jsonb_typeof(entitlement_state->'groupId') = 'string'
            AND effect->'groupAssignment'->>'groupId' = entitlement_state->>'groupId')
        )
      ))
    ON CONFLICT (event_id, entity_type, entity_id, relationship) DO NOTHING;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION record_audit_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.capture_audit_subjects(NEW, 'recorded');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_admin_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Completed operations are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'admin_operations_immutable';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_configuration_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'Configuration revision is server controlled'
      USING ERRCODE = '23514', CONSTRAINT = 'configuration_revision_server_controlled';
  END IF;
  IF (to_jsonb(NEW) - 'revision') IS DISTINCT FROM (to_jsonb(OLD) - 'revision') THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION touch_client_resource_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.client_id = OLD.client_id AND NEW.resource_id = OLD.resource_id AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  FOR target IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.client_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.client_id END
    ]) AS targets(value) WHERE value IS NOT NULL ORDER BY value
  LOOP
    UPDATE public.oauth_clients
    SET updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE client_id = target;
  END LOOP;
  FOR target IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.resource_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.resource_id END
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
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
CREATE FUNCTION protect_group_assignment_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
CREATE FUNCTION protect_resource_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.classification IS DISTINCT FROM OLD.classification OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Resource ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
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
CREATE FUNCTION protect_capability_target() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.resource IS DISTINCT FROM OLD.resource OR NEW.grant_kind IS DISTINCT FROM OLD.grant_kind) THEN
    RAISE EXCEPTION 'Capability identity and target are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.grant_kind = 'admin_session' AND NOT EXISTS (SELECT 1 FROM system_bindings b JOIN oauth_resources r ON r.id = b.resource_id WHERE r.identifier = NEW.resource) THEN
    RAISE EXCEPTION 'Direct administration requires the bound admin resource' USING ERRCODE = '23514';
  END IF;
  IF NEW.grant_kind = 'client_credentials' AND NOT EXISTS (SELECT 1 FROM oauth_clients c WHERE c.client_id = NEW.client_id AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Machine capability requires the owning tenant' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.scopes) s WHERE s LIKE 'platform:%') AND NOT EXISTS (SELECT 1 FROM system_bindings b WHERE b.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Platform scopes require the bound platform organisation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The fixed provenance guard must lock members without granting admission callers UPDATE.
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
      AND NEW.requested_scopes <@ c.scopes
    FOR SHARE OF m, o, u, s, c;
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
CREATE FUNCTION protect_session_authentication_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.user_id, NEW.created_at, NEW.authentication_organization_id, NEW.authentication_provider_id, NEW.authentication_provider_revision, NEW.authentication_account_id, NEW.upstream_auth_time)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.created_at, OLD.authentication_organization_id, OLD.authentication_provider_id, OLD.authentication_provider_revision, OLD.authentication_account_id, OLD.upstream_auth_time) THEN
      RAISE EXCEPTION 'Session identity and authentication origin are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_immutable';
    END IF;
  ELSIF NEW.authentication_provider_id IS NOT NULL THEN
    PERFORM 1 FROM sso_providers p
      JOIN accounts a ON a.id = NEW.authentication_account_id
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
CREATE FUNCTION protect_product_deletion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Product deletion is terminal' USING ERRCODE = '23514', CONSTRAINT = 'product_deletion_terminal';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF TG_TABLE_NAME IN ('organizations', 'groups', 'oauth_resources') AND EXISTS (
      SELECT 1 FROM public.system_bindings b WHERE
        (TG_TABLE_NAME = 'organizations' AND b.organization_id = OLD.id)
        OR (TG_TABLE_NAME = 'groups' AND b.group_id = OLD.id)
        OR (TG_TABLE_NAME = 'oauth_resources' AND b.resource_id = OLD.id)
    ) THEN
      RAISE EXCEPTION 'Bound platform objects cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'system_binding_protected';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF TG_TABLE_NAME = 'organizations' AND (
      EXISTS (SELECT 1 FROM public.oauth_clients WHERE organization_id = OLD.id AND deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.oauth_resources WHERE organization_id = OLD.id AND deleted_at IS NULL)
    ) OR TG_TABLE_NAME = 'oauth_clients' AND (
      EXISTS (SELECT 1 FROM public.entitlements WHERE client_id = to_jsonb(OLD)->>'client_id' AND deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.organization_capabilities WHERE client_id = to_jsonb(OLD)->>'client_id' AND deleted_at IS NULL)
    ) OR TG_TABLE_NAME = 'oauth_resources' AND (
      EXISTS (SELECT 1 FROM public.entitlements WHERE resource = to_jsonb(OLD)->>'identifier' AND deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.organization_capabilities WHERE resource = to_jsonb(OLD)->>'identifier' AND deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.oauth_client_resources WHERE resource_id = to_jsonb(OLD)->>'identifier' AND deleted_at IS NULL)
    ) THEN
      RAISE EXCEPTION 'Remove live product references before deletion' USING ERRCODE = '23503', CONSTRAINT = 'product_live_references';
    END IF;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    IF TG_TABLE_NAME IN ('users', 'organizations', 'groups', 'entitlements', 'organization_domains', 'organization_capabilities')
      AND to_jsonb(NEW)->>'status' <> 'disabled'
      OR TG_TABLE_NAME = 'members' AND to_jsonb(NEW)->>'status' <> 'revoked'
      OR TG_TABLE_NAME IN ('oauth_clients', 'oauth_resources') AND to_jsonb(NEW)->>'disabled' <> 'true'
      OR TG_TABLE_NAME = 'accounts' AND (to_jsonb(NEW)->>'access_token' IS NOT NULL OR to_jsonb(NEW)->>'refresh_token' IS NOT NULL OR to_jsonb(NEW)->>'id_token' IS NOT NULL OR to_jsonb(NEW)->>'password' IS NOT NULL)
      OR TG_TABLE_NAME = 'oauth_clients' AND to_jsonb(NEW)->>'client_secret' IS NOT NULL
      OR TG_TABLE_NAME = 'sso_providers' AND (to_jsonb(NEW)->>'oidc_config' IS NOT NULL OR to_jsonb(NEW)->>'saml_config' IS NOT NULL) THEN
      RAISE EXCEPTION 'Deleted product objects cannot confer authority or retain credentials' USING ERRCODE = '23514', CONSTRAINT = 'product_deletion_inactive';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION require_present_parent(parent_table regclass, parent_column name, parent_value text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE present boolean;
BEGIN
  IF parent_value IS NULL THEN RETURN; END IF;
  EXECUTE format('SELECT true FROM %s WHERE %I = $1::%s AND deleted_at IS NULL FOR SHARE', parent_table, parent_column, CASE WHEN parent_column = 'id' THEN 'uuid' ELSE 'text' END)
    INTO present USING parent_value;
  IF present IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Parent is unavailable' USING ERRCODE = '23503', CONSTRAINT = 'product_parent_unavailable';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_product_parents() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE row_data jsonb := to_jsonb(NEW);
BEGIN
  IF row_data->>'deleted_at' IS NOT NULL OR row_data->>'revoked' IS NOT NULL OR row_data->>'revoked_at' IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM public.require_present_parent('public.organizations', 'id', row_data->>'organization_id');
  IF TG_TABLE_NAME <> 'sso_providers' THEN
    PERFORM public.require_present_parent('public.users', 'id', row_data->>'user_id');
  END IF;
  PERFORM public.require_present_parent('public.users', 'id', row_data->>'inviter_id');
  PERFORM public.require_present_parent('public.members', 'id', row_data->>'member_id');
  PERFORM public.require_present_parent('public.groups', 'id', row_data->>'group_id');
  IF TG_TABLE_NAME <> 'oauth_clients' THEN
    PERFORM public.require_present_parent('public.oauth_clients', 'client_id', row_data->>'client_id');
  END IF;
  IF TG_TABLE_NAME <> 'oauth_resources' THEN
    PERFORM public.require_present_parent('public.oauth_resources', 'identifier', coalesce(row_data->>'resource', row_data->>'resource_id'));
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Validate fixed provenance independently of caller visibility; RLS still controls admission.
CREATE FUNCTION validate_grant_authentication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE evidence jsonb;
BEGIN
  IF NEW.authentication IS NULL THEN RETURN NEW; END IF;
  SELECT jsonb_build_object(
    'userId', s.user_id, 'memberId', m.id, 'authenticationSessionId', s.id,
    'authenticationAccountId', a.id, 'authenticationOrganizationId', p.organization_id,
    'authenticationProviderId', p.id, 'authenticationProviderRevision', p.revision,
    'brokerAuthenticatedAt', to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'upstreamAuthTime', CASE WHEN s.upstream_auth_time IS NULL THEN NULL ELSE to_char(s.upstream_auth_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'sessionExpiresAt', to_char(s.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO evidence
  FROM public.sessions s
  JOIN public.accounts a ON a.id = s.authentication_account_id AND a.user_id = s.user_id AND a.deleted_at IS NULL
  JOIN public.sso_providers p ON p.id = s.authentication_provider_id AND p.revision = s.authentication_provider_revision
    AND p.organization_id = s.authentication_organization_id AND p.issuer = a.issuer AND p.provider_id = a.provider_id AND p.deleted_at IS NULL
  JOIN public.members m ON m.user_id = s.user_id AND m.organization_id = p.organization_id
  WHERE s.id = NEW.authentication_session_id AND s.user_id = NEW.user_id AND s.created_at = NEW.auth_time
    AND m.id = NEW.member_id AND m.organization_id = NEW.organization_id;
  IF evidence IS NULL OR evidence <> NEW.authentication THEN
    RAISE EXCEPTION 'Invalid grant authentication evidence' USING ERRCODE = '23514', CONSTRAINT = 'grant_authentication_provenance';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION record_user_oauth_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE g public.grant_contexts; public_client text; source jsonb;
BEGIN
  IF NEW.schema_version <> 4 OR NEW.action NOT IN (
    'oauth.user.authorized', 'oauth.user.denied', 'oauth.user.issued', 'oauth.user.replayed', 'oauth.user.revoked'
  ) THEN RETURN NEW; END IF;
  SELECT * INTO g FROM public.grant_contexts WHERE id = public.try_uuid(NEW.target_id);
  SELECT client_id INTO public_client FROM public.oauth_clients WHERE id = g.client_instance_id;
  IF g.id IS NULL OR NEW.target_type <> 'grant_context' OR NEW.organization_id IS DISTINCT FROM g.organization_id
    OR NOT ((NEW.actor_type = 'user' AND NEW.actor_id = g.user_id::text) OR (NEW.actor_type = 'client' AND NEW.actor_id = public_client))
    OR NEW.data->'authentication' IS DISTINCT FROM g.authentication OR g.authentication IS NULL THEN
    RAISE EXCEPTION 'Invalid user OAuth outcome' USING ERRCODE = '23514', CONSTRAINT = 'user_oauth_audit_provenance';
  END IF;
  INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
  SELECT NEW.id, subject.kind, subject.id, subject.relationship, g.organization_id, 'recorded'
  FROM (VALUES
    ('user', g.user_id::text, 'affected'), ('member', g.member_id::text, 'authorized'),
    ('organization', g.organization_id::text, 'authorized'), ('client', g.client_instance_id::text, 'authorized'),
    ('resource', g.resource_instance_id::text, 'authorized'),
    ('session', g.authentication_session_id::text, 'authenticated'),
    ('account', g.authentication->>'authenticationAccountId', 'authenticated'),
    ('sso_provider', g.authentication->>'authenticationProviderId', 'authenticated')
  ) AS subject(kind, id, relationship) WHERE subject.id IS NOT NULL;
  FOR source IN SELECT value FROM jsonb_array_elements(coalesce(NEW.data->'decision'->'evidence'->'capabilities', '[]'::jsonb)) LOOP
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (NEW.id, 'capability', (source->>'id')::uuid::text, 'authorized', g.organization_id, 'recorded') ON CONFLICT DO NOTHING;
  END LOOP;
  FOR source IN SELECT value FROM jsonb_array_elements(coalesce(NEW.data->'decision'->'evidence'->'assignments', '[]'::jsonb)) LOOP
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (NEW.id, 'entitlement', (source->>'id')::uuid::text, 'authorized', g.organization_id, 'recorded') ON CONFLICT DO NOTHING;
    IF source->>'groupId' IS NOT NULL THEN
      INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
      VALUES (NEW.id, 'group', (source->>'groupId')::uuid::text, 'authorized', g.organization_id, 'recorded'),
        (NEW.id, 'group_member', (source->'groupMembership'->>'id')::uuid::text, 'authorized', g.organization_id, 'recorded') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
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
CREATE TRIGGER system_bindings_immutable BEFORE UPDATE OR DELETE ON system_bindings
FOR EACH ROW EXECUTE FUNCTION protect_system_binding();
--> statement-breakpoint
CREATE TRIGGER audit_events_capture_subjects AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION record_audit_subjects();
--> statement-breakpoint
CREATE TRIGGER admin_operations_immutable BEFORE UPDATE OR DELETE ON admin_operations
FOR EACH ROW EXECUTE FUNCTION protect_admin_operation();
--> statement-breakpoint
CREATE TRIGGER oauth_clients_revision_guard BEFORE UPDATE ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER oauth_client_resources_revision AFTER INSERT OR UPDATE OR DELETE ON oauth_client_resources
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
FOR EACH ROW EXECUTE FUNCTION protect_sso_provider_revision();
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
CREATE TRIGGER resource_ownership_immutable BEFORE UPDATE ON oauth_resources FOR EACH ROW EXECUTE FUNCTION protect_resource_ownership();
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
CREATE TRIGGER users_deletion_guard BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER organizations_deletion_guard BEFORE INSERT OR UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER accounts_deletion_guard BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER members_deletion_guard BEFORE INSERT OR UPDATE ON members FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER invitations_deletion_guard BEFORE INSERT OR UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER organization_domains_deletion_guard BEFORE INSERT OR UPDATE ON organization_domains FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER groups_deletion_guard BEFORE INSERT OR UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER group_members_deletion_guard BEFORE INSERT OR UPDATE ON group_members FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER entitlements_deletion_guard BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_clients_deletion_guard BEFORE INSERT OR UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_deletion_guard BEFORE INSERT OR UPDATE ON oauth_resources FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_client_resources_deletion_guard BEFORE INSERT OR UPDATE ON oauth_client_resources FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_consents_deletion_guard BEFORE INSERT OR UPDATE ON oauth_consents FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER sso_providers_deletion_guard BEFORE INSERT OR UPDATE ON sso_providers FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER organization_capabilities_deletion_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER zz_accounts_present_parents BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_members_present_parents BEFORE INSERT OR UPDATE ON members FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_invitations_present_parents BEFORE INSERT OR UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_organization_domains_present_parents BEFORE INSERT OR UPDATE ON organization_domains FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_groups_present_parents BEFORE INSERT OR UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_group_members_present_parents BEFORE INSERT OR UPDATE ON group_members FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_entitlements_present_parents BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_clients_present_parents BEFORE INSERT OR UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_resources_present_parents BEFORE INSERT OR UPDATE ON oauth_resources FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_client_resources_present_parents BEFORE INSERT OR UPDATE ON oauth_client_resources FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_consents_present_parents BEFORE INSERT OR UPDATE ON oauth_consents FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_sso_providers_present_parents BEFORE INSERT OR UPDATE ON sso_providers FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_organization_capabilities_present_parents BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_sessions_present_parents BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_access_tokens_present_parents BEFORE INSERT OR UPDATE ON oauth_access_tokens FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_refresh_tokens_present_parents BEFORE INSERT OR UPDATE ON oauth_refresh_tokens FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER grant_authentication_provenance BEFORE INSERT ON grant_contexts
FOR EACH ROW EXECUTE FUNCTION validate_grant_authentication();
--> statement-breakpoint
CREATE TRIGGER audit_events_user_oauth_subjects AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION record_user_oauth_subjects();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION protect_grant_context(), capture_audit_subjects(audit_events, text), record_audit_subjects(), record_user_oauth_subjects(), validate_grant_authentication() FROM PUBLIC;

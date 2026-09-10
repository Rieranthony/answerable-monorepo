ALTER TABLE "oauth_client_resources" DROP CONSTRAINT "oauth_client_resources_client_id_resource_id_unique";--> statement-breakpoint
ALTER TABLE "entitlements" DROP CONSTRAINT "entitlements_principal_target_unique";--> statement-breakpoint
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_id_unique";--> statement-breakpoint
ALTER TABLE "organization_domains" DROP CONSTRAINT "organization_domains_organization_id_domain_unique";--> statement-breakpoint
ALTER TABLE "sso_providers" DROP CONSTRAINT "sso_providers_organization_id_unique";--> statement-breakpoint
ALTER TABLE "organization_capabilities" DROP CONSTRAINT "organization_capabilities_target_kind_unique";--> statement-breakpoint
DROP INDEX "organization_domains_active_domain_idx";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_resources" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_members" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_domains" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_resources_client_id_resource_id_unique" ON "oauth_client_resources" USING btree ("client_id","resource_id") WHERE "oauth_client_resources"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_principal_target_unique" ON "entitlements" USING btree ("organization_id","member_id","group_id","client_id","resource") NULLS NOT DISTINCT WHERE "entitlements"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_live_assignment_unique" ON "group_members" USING btree ("group_id","member_id") WHERE "group_members"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_domains_organization_id_domain_unique" ON "organization_domains" USING btree ("organization_id","domain") WHERE "organization_domains"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_providers_organization_id_unique" ON "sso_providers" USING btree ("organization_id") WHERE "sso_providers"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_capabilities_target_kind_unique" ON "organization_capabilities" USING btree ("organization_id","client_id","resource","grant_kind") NULLS NOT DISTINCT WHERE "organization_capabilities"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_domains_active_domain_idx" ON "organization_domains" USING btree ("domain") WHERE "organization_domains"."status" = 'active' and "organization_domains"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_pkey";
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_pkey" PRIMARY KEY("id");

--> statement-breakpoint
-- Product tombstones are terminal. Credentials and protocol reservations retain
-- their separate consumption/revocation rules.
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
    IF TG_TABLE_NAME = 'organization_capabilities' AND to_jsonb(OLD)->>'grant_kind' = 'admin_session'
      AND EXISTS (SELECT 1 FROM public.system_bindings WHERE organization_id = (to_jsonb(OLD)->>'organization_id')::uuid) THEN
      RAISE EXCEPTION 'Bound platform capability cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'reserved_admin_capability';
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
  -- Retirement remains possible after a parent is marked deleted in this transaction.
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
CREATE OR REPLACE FUNCTION protect_grant_context() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
  PERFORM 1 FROM members m
    JOIN organizations o ON o.id = m.organization_id
    JOIN users u ON u.id = m.user_id
    JOIN sessions s ON s.user_id = u.id
    JOIN oauth_clients c ON c.id = NEW.client_instance_id
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
    PERFORM 1 FROM oauth_resources r WHERE r.id = NEW.resource_instance_id
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
CREATE OR REPLACE FUNCTION protect_session_authentication_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.user_id, NEW.created_at, NEW.authentication_organization_id, NEW.authentication_provider_id, NEW.authentication_provider_revision)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.created_at, OLD.authentication_organization_id, OLD.authentication_provider_id, OLD.authentication_provider_revision) THEN
      RAISE EXCEPTION 'Session identity and authentication origin are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_immutable';
    END IF;
  ELSIF NEW.authentication_provider_id IS NOT NULL THEN
    PERFORM 1 FROM sso_providers p
      WHERE p.id = NEW.authentication_provider_id
        AND p.organization_id = NEW.authentication_organization_id
        AND p.revision = NEW.authentication_provider_revision AND p.deleted_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session authentication origin must match its provider'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_provider';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_audit_subjects(event public.audit_events, origin text) RETURNS void
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
    WHERE id::text = event.target_id AND (event.organization_id IS NULL OR organization_id = event.organization_id);
    related_user := coalesce(related_user, event.data->>'userId');
  ELSIF (event.schema_version = 1 OR (event.schema_version = 3 AND event.action = 'entitlement.removed' AND event.data->>'deletionMode' = 'soft')) AND event.outcome = 'success'
    AND event.organization_id IS NOT NULL AND event.target_type = 'entitlement'
    AND event.target_id IS NOT NULL AND event.action IN (
      'entitlement.created', 'entitlement.updated', 'entitlement.update_unchanged',
      'entitlement.enabled', 'entitlement.disabled', 'entitlement.enable_unchanged',
      'entitlement.disable_unchanged', 'entitlement.removed'
    ) THEN
    -- Supported commands hold the inserted/locked child through event insertion.
    -- A concurrent parent erasure cannot commit its cascade before this capture.
    SELECT user_id::text INTO related_user FROM public.members
    WHERE id::text = entitlement_state->>'memberId'
      AND organization_id = event.organization_id
      AND entitlement_state->>'organizationId' = event.organization_id::text
      AND entitlement_state->>'id' = event.target_id;
  ELSIF event.target_type = 'session' THEN
    SELECT user_id::text INTO related_user FROM public.sessions WHERE id::text = event.target_id;
    related_user := coalesce(related_user, event.data->>'userId');
  END IF;
  IF related_user IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, 'user', related_user, 'affected', event.organization_id, origin);
  END IF;
  -- Explicit versioned contracts only; do not recursively infer subjects from JSON.
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
CREATE OR REPLACE FUNCTION touch_client_resource_revision() RETURNS trigger
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

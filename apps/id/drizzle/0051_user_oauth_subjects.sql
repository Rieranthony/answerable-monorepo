CREATE FUNCTION validate_grant_authentication() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE evidence jsonb;
BEGIN
  -- Old contexts have no complete evidence and are refused by the user provider.
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
CREATE TRIGGER grant_authentication_provenance BEFORE INSERT ON grant_contexts
FOR EACH ROW EXECUTE FUNCTION validate_grant_authentication();
--> statement-breakpoint
CREATE FUNCTION record_user_oauth_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE g public.grant_contexts; public_client text; source jsonb;
BEGIN
  IF NEW.schema_version <> 4 OR NEW.action NOT IN (
    'oauth.user.authorized', 'oauth.user.denied', 'oauth.user.issued', 'oauth.user.replayed', 'oauth.user.revoked'
  ) THEN RETURN NEW; END IF;
  SELECT * INTO g FROM public.grant_contexts WHERE id::text = NEW.target_id;
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
  -- Capture only the versioned policy arrays written with this outcome.
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
CREATE TRIGGER audit_events_user_oauth_subjects AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION record_user_oauth_subjects();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION record_user_oauth_subjects(), validate_grant_authentication() FROM PUBLIC;

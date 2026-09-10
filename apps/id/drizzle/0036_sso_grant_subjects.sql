CREATE OR REPLACE FUNCTION capture_audit_subjects(event public.audit_events, origin text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE related_user text; grant_effects jsonb;
BEGIN
  INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
  VALUES (event.id, event.actor_type, event.actor_id, 'actor', event.organization_id, origin);
  IF event.target_id IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, event.target_type, event.target_id, 'target', event.organization_id, origin);
  END IF;
  IF event.target_type IN ('member', 'group_member') THEN
    SELECT user_id::text INTO related_user FROM public.members
    WHERE id::text = event.target_id AND (event.organization_id IS NULL OR organization_id = event.organization_id);
    related_user := coalesce(related_user, event.data->>'userId');
  ELSIF event.target_type = 'session' THEN
    SELECT user_id::text INTO related_user FROM public.sessions WHERE id::text = event.target_id;
    related_user := coalesce(related_user, event.data->>'userId');
  END IF;
  IF related_user IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, 'user', related_user, 'affected', event.organization_id, origin);
  END IF;
  -- Explicit versioned contracts only; do not recursively infer subjects from JSON.
  grant_effects := CASE
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
  IF jsonb_typeof(grant_effects) = 'array' THEN
    INSERT INTO public.audit_event_subjects
      (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    SELECT DISTINCT event.id, 'user', effect->>'userId', 'affected', event.organization_id, origin
    FROM jsonb_array_elements(grant_effects) AS effects(effect)
    WHERE jsonb_typeof(effect->'userId') = 'string' AND effect->>'userId' <> ''
    ON CONFLICT (event_id, entity_type, entity_id, relationship) DO NOTHING;
  END IF;
END;
$$;
--> statement-breakpoint
-- Only recorded version-one SSO effects are eligible; never guess from live identities.
INSERT INTO public.audit_event_subjects
  (event_id, entity_type, entity_id, relationship, organization_id, provenance)
SELECT DISTINCT event.id, 'user', effect->>'userId', 'affected', event.organization_id, 'recorded'
FROM public.audit_events event
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(event.data->'effects'->'revokedGrantContexts') = 'array'
    THEN event.data->'effects'->'revokedGrantContexts' ELSE '[]'::jsonb END
) AS effects(effect)
WHERE event.schema_version = 1 AND event.outcome = 'success'
  AND event.organization_id IS NOT NULL AND event.target_type = 'sso_provider'
  AND event.action IN ('sso_provider.created', 'sso_provider.updated', 'sso_provider.deleted')
  AND jsonb_typeof(effect->'userId') = 'string' AND effect->>'userId' <> ''
ON CONFLICT (event_id, entity_type, entity_id, relationship) DO NOTHING;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION capture_audit_subjects(audit_events, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION capture_audit_subjects(event public.audit_events, origin text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE related_user text;
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
  -- These are explicit committed effect IDs, not guesses from live relations.
  -- The event is global; one affected-user reference spans all of their contexts.
  IF event.schema_version = 1 AND event.action = 'user.erased'
    AND event.target_type = 'user' AND event.organization_id IS NULL
    AND event.outcome = 'success'
    AND jsonb_typeof(event.data->'deletedGrantContexts') = 'array' THEN
    INSERT INTO public.audit_event_subjects
      (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    SELECT DISTINCT event.id, 'user', effect->>'userId', 'affected', NULL::uuid, origin
    FROM jsonb_array_elements(event.data->'deletedGrantContexts') AS effects(effect)
    WHERE jsonb_typeof(effect->'userId') = 'string' AND effect->>'userId' <> ''
    ON CONFLICT (event_id, entity_type, entity_id, relationship) DO NOTHING;
  END IF;
END;
$$;
--> statement-breakpoint
-- Recover only references already present in version-one global erasure facts.
-- No event payload or timestamp is rewritten, and no live identity is consulted.
INSERT INTO public.audit_event_subjects
  (event_id, entity_type, entity_id, relationship, organization_id, provenance)
SELECT DISTINCT event.id, 'user', effect->>'userId', 'affected', NULL::uuid, 'recorded'
FROM public.audit_events event
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(event.data->'deletedGrantContexts') = 'array'
    THEN event.data->'deletedGrantContexts' ELSE '[]'::jsonb END
) AS effects(effect)
WHERE event.schema_version = 1 AND event.action = 'user.erased'
  AND event.target_type = 'user' AND event.organization_id IS NULL
  AND event.outcome = 'success'
  AND jsonb_typeof(effect->'userId') = 'string' AND effect->>'userId' <> ''
ON CONFLICT (event_id, entity_type, entity_id, relationship) DO NOTHING;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION capture_audit_subjects(audit_events, text) FROM PUBLIC;

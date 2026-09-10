ALTER TABLE "grant_contexts" ADD COLUMN "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_authorization_code_id_unique" UNIQUE("authorization_code_id");--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_code_check" CHECK ("grant_contexts"."authorization_code_id" is null or length("grant_contexts"."authorization_code_id") > 0);
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
      AND o.status = 'active' AND u.status = 'active'
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
      AND r.disabled = false
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

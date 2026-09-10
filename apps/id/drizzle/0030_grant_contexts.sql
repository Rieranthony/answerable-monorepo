CREATE TABLE "grant_contexts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_instance_id" uuid NOT NULL,
	"resource_instance_id" uuid,
	"authentication_session_id" uuid NOT NULL,
	"auth_time" timestamp with time zone NOT NULL,
	"requested_scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "grant_contexts_expiry_check" CHECK ("grant_contexts"."expires_at" > "grant_contexts"."created_at"),
	CONSTRAINT "grant_contexts_scopes_check" CHECK (cardinality("grant_contexts"."requested_scopes") > 0 and array_position("grant_contexts"."requested_scopes", '') is null and array_position("grant_contexts"."requested_scopes", null) is null)
);
--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_client_instance_id_oauth_clients_id_fk" FOREIGN KEY ("client_instance_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_resource_instance_id_oauth_resources_id_fk" FOREIGN KEY ("resource_instance_id") REFERENCES "public"."oauth_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grant_contexts_member_id_idx" ON "grant_contexts" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_user_id_idx" ON "grant_contexts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_client_instance_id_idx" ON "grant_contexts" USING btree ("client_instance_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_resource_instance_id_idx" ON "grant_contexts" USING btree ("resource_instance_id");--> statement-breakpoint
CREATE FUNCTION protect_grant_context() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
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
--> statement-breakpoint
CREATE TRIGGER grant_context_guard BEFORE INSERT OR UPDATE ON grant_contexts
FOR EACH ROW EXECUTE FUNCTION protect_grant_context();

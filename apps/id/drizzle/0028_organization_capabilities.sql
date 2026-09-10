CREATE TABLE "organization_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" text,
	"resource" text,
	"grant_kind" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "organization_capabilities_target_kind_unique" UNIQUE NULLS NOT DISTINCT("organization_id","client_id","resource","grant_kind"),
	CONSTRAINT "organization_capabilities_revision_check" CHECK ("organization_capabilities"."revision" > 0),
	CONSTRAINT "organization_capabilities_kind_check" CHECK ("organization_capabilities"."grant_kind" in ('admin_session', 'authorization_code', 'refresh_token', 'client_credentials')),
	CONSTRAINT "organization_capabilities_status_check" CHECK ("organization_capabilities"."status" in ('active', 'disabled')),
	CONSTRAINT "organization_capabilities_target_check" CHECK (
    ("organization_capabilities"."grant_kind" = 'admin_session' and "organization_capabilities"."client_id" is null and "organization_capabilities"."resource" is not null)
    or ("organization_capabilities"."grant_kind" = 'authorization_code' and "organization_capabilities"."client_id" is not null)
    or ("organization_capabilities"."grant_kind" in ('refresh_token', 'client_credentials') and "organization_capabilities"."client_id" is not null and "organization_capabilities"."resource" is not null)),
	CONSTRAINT "organization_capabilities_scopes_check" CHECK (cardinality("organization_capabilities"."scopes") > 0 and array_position("organization_capabilities"."scopes", '') is null and array_position("organization_capabilities"."scopes", null) is null),
	CONSTRAINT "organization_capabilities_window_check" CHECK ("organization_capabilities"."valid_from" < "organization_capabilities"."valid_until")
);
--> statement-breakpoint
ALTER TABLE "organization_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_resource_oauth_resources_identifier_fk" FOREIGN KEY ("resource") REFERENCES "public"."oauth_resources"("identifier") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "capability_write" ON "organization_capabilities" AS PERMISSIVE FOR ALL TO public USING (current_setting('answerable.scope', true) = 'platform-write') WITH CHECK (current_setting('answerable.scope', true) = 'platform-write');--> statement-breakpoint
CREATE POLICY "capability_read" ON "organization_capabilities" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "organization_capabilities"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
      or (current_setting('answerable.scope', true) = 'policy-user' and "organization_capabilities"."organization_id" in (select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid))
      or (current_setting('answerable.scope', true) = 'policy-root' and "organization_capabilities"."organization_id" in (select organization_id from system_bindings)));--> statement-breakpoint
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
CREATE TRIGGER capability_target_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_capability_target();
--> statement-breakpoint
CREATE TRIGGER capability_private_resource_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_private_resource_assignment();
--> statement-breakpoint
CREATE TRIGGER capability_revision_guard BEFORE UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();

CREATE TABLE "system_bindings" (
	"name" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "system_bindings_name_check" CHECK ("system_bindings"."name" in ('platform'))
);
--> statement-breakpoint
ALTER TABLE "system_bindings" ADD CONSTRAINT "system_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_bindings" ADD CONSTRAINT "system_bindings_resource_id_oauth_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_bindings" ADD CONSTRAINT "system_bindings_organization_id_group_id_groups_organization_id_id_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "public"."groups"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION protect_system_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'System bindings are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'system_bindings_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER system_bindings_immutable BEFORE UPDATE OR DELETE ON system_bindings
FOR EACH ROW EXECUTE FUNCTION protect_system_binding();

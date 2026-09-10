ALTER TABLE "entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_write" ON "entitlements" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "entitlements"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "entitlements"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_read" ON "entitlements" AS PERMISSIVE FOR SELECT TO public USING (((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "entitlements"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
    or current_setting('answerable.scope', true) = 'platform-read'
    or (current_setting('answerable.scope', true) = 'tenant-read' and "entitlements"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (current_setting('answerable.scope', true) = 'policy-user' and "entitlements"."organization_id" in (
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid
    ))
    or (current_setting('answerable.scope', true) = 'policy-root' and "entitlements"."organization_id" in (select organization_id from system_bindings))));--> statement-breakpoint
CREATE POLICY "tenant_write" ON "group_members" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "group_members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "group_members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_read" ON "group_members" AS PERMISSIVE FOR SELECT TO public USING (((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "group_members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
    or current_setting('answerable.scope', true) = 'platform-read'
    or (current_setting('answerable.scope', true) = 'tenant-read' and "group_members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (current_setting('answerable.scope', true) = 'policy-user' and "group_members"."organization_id" in (
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid
    ))
    or (current_setting('answerable.scope', true) = 'policy-root' and "group_members"."organization_id" in (select organization_id from system_bindings))));--> statement-breakpoint
CREATE POLICY "tenant_write" ON "groups" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "groups"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "groups"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_read" ON "groups" AS PERMISSIVE FOR SELECT TO public USING (((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "groups"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
    or current_setting('answerable.scope', true) = 'platform-read'
    or (current_setting('answerable.scope', true) = 'tenant-read' and "groups"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (current_setting('answerable.scope', true) = 'policy-user' and "groups"."organization_id" in (
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid
    ))
    or (current_setting('answerable.scope', true) = 'policy-root' and "groups"."organization_id" in (select organization_id from system_bindings))));
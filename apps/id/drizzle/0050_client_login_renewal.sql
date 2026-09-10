ALTER TABLE "organization_capabilities" DROP CONSTRAINT "organization_capabilities_target_check";--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_target_check" CHECK (
    ("organization_capabilities"."grant_kind" = 'admin_session' and "organization_capabilities"."client_id" is null and "organization_capabilities"."resource" is not null)
    or ("organization_capabilities"."grant_kind" in ('authorization_code', 'refresh_token') and "organization_capabilities"."client_id" is not null)
    or ("organization_capabilities"."grant_kind" = 'client_credentials' and "organization_capabilities"."client_id" is not null and "organization_capabilities"."resource" is not null));
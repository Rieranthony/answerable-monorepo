CREATE TABLE "magic_link_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"provider_revision" integer NOT NULL,
	"purpose" text NOT NULL,
	"email" text NOT NULL,
	"token_identifier" text,
	"browser_hash" text,
	"client_hash" text NOT NULL,
	"code_hmac" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"new_address" boolean DEFAULT false NOT NULL,
	"pending_oauth_query" text,
	"directory_issuer" text,
	"directory_subject" text,
	"directory_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"send_status" text DEFAULT 'sent' NOT NULL,
	"postmark_error_code" integer,
	"postmark_http_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_requests_token_identifier_unique" UNIQUE("token_identifier"),
	CONSTRAINT "magic_link_requests_email_normalized_check" CHECK ("magic_link_requests"."email" = lower(btrim("magic_link_requests"."email"))),
	CONSTRAINT "magic_link_requests_provider_revision_check" CHECK ("magic_link_requests"."provider_revision" > 0),
	CONSTRAINT "magic_link_requests_attempts_check" CHECK ("magic_link_requests"."attempts" >= 0),
	CONSTRAINT "magic_link_requests_purpose_check" CHECK ("magic_link_requests"."purpose" in ('link', 'connect_directory')),
	CONSTRAINT "magic_link_requests_send_status_check" CHECK ("magic_link_requests"."send_status" in ('sent', 'failed')),
	CONSTRAINT "magic_link_requests_purpose_fields_check" CHECK (("magic_link_requests"."purpose" = 'link' and "magic_link_requests"."token_identifier" is not null and "magic_link_requests"."browser_hash" is not null and "magic_link_requests"."code_hmac" is not null and "magic_link_requests"."directory_issuer" is null and "magic_link_requests"."directory_subject" is null and "magic_link_requests"."directory_user_id" is null) or ("magic_link_requests"."purpose" = 'connect_directory' and "magic_link_requests"."token_identifier" is null and "magic_link_requests"."browser_hash" is not null and "magic_link_requests"."code_hmac" is not null and "magic_link_requests"."directory_issuer" is not null and "magic_link_requests"."directory_subject" is not null and "magic_link_requests"."directory_user_id" is not null and not "magic_link_requests"."new_address")),
	CONSTRAINT "magic_link_requests_send_error_check" CHECK ("magic_link_requests"."send_status" = 'failed' or ("magic_link_requests"."postmark_error_code" is null and "magic_link_requests"."postmark_http_status" is null))
);
--> statement-breakpoint
ALTER TABLE "magic_link_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "sso_providers_organization_id_unique";--> statement-breakpoint
ALTER TABLE "organization_domains" ADD COLUMN "verification_token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_domains" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD COLUMN "kind" text DEFAULT 'oidc' NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD COLUMN "admission" text DEFAULT 'listed' NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_link_requests" ADD CONSTRAINT "magic_link_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "magic_link_requests_email_created_at_idx" ON "magic_link_requests" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "magic_link_requests_new_address_organization_idx" ON "magic_link_requests" USING btree ("organization_id","created_at") WHERE "magic_link_requests"."new_address" and "magic_link_requests"."send_status" <> 'failed';--> statement-breakpoint
CREATE INDEX "magic_link_requests_new_address_client_idx" ON "magic_link_requests" USING btree ("client_hash","created_at") WHERE "magic_link_requests"."new_address" and "magic_link_requests"."send_status" <> 'failed';--> statement-breakpoint
CREATE INDEX "magic_link_requests_browser_hash_idx" ON "magic_link_requests" USING btree ("browser_hash");--> statement-breakpoint
CREATE INDEX "magic_link_requests_created_at_idx" ON "magic_link_requests" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_providers_organization_kind_unique" ON "sso_providers" USING btree ("organization_id","kind") WHERE "sso_providers"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_kind_check" CHECK ("sso_providers"."kind" in ('oidc', 'magic_link'));--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_kind_config_check" CHECK (("sso_providers"."kind" = 'oidc' and ("sso_providers"."deleted_at" is not null or "sso_providers"."oidc_config" is not null)) or ("sso_providers"."kind" = 'magic_link' and "sso_providers"."oidc_config" is null));--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_enabled_check" CHECK ("sso_providers"."kind" = 'magic_link' or "sso_providers"."enabled");--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_admission_check" CHECK ("sso_providers"."admission" in ('listed', 'domain'));--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_admission_kind_check" CHECK ("sso_providers"."kind" = 'magic_link' or "sso_providers"."admission" = 'listed');--> statement-breakpoint
CREATE POLICY "protocol_write" ON "magic_link_requests" AS PERMISSIVE FOR ALL TO public USING (current_setting('answerable.scope', true) = 'protocol') WITH CHECK (current_setting('answerable.scope', true) = 'protocol');--> statement-breakpoint
CREATE POLICY "protocol_read" ON "magic_link_requests" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "magic_link_requests"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid));
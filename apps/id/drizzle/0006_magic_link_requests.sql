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
	"pending_oauth_query" text,
	"expires_at" timestamp with time zone NOT NULL,
	"send_status" text DEFAULT 'sending' NOT NULL,
	"postmark_error_code" integer,
	"postmark_http_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_requests_token_identifier_unique" UNIQUE("token_identifier"),
	CONSTRAINT "magic_link_requests_email_normalized_check" CHECK ("magic_link_requests"."email" = lower(btrim("magic_link_requests"."email"))),
	CONSTRAINT "magic_link_requests_provider_revision_check" CHECK ("magic_link_requests"."provider_revision" > 0),
	CONSTRAINT "magic_link_requests_attempts_check" CHECK ("magic_link_requests"."attempts" >= 0),
	CONSTRAINT "magic_link_requests_purpose_check" CHECK ("magic_link_requests"."purpose" in ('link', 'access_removed')),
	CONSTRAINT "magic_link_requests_send_status_check" CHECK ("magic_link_requests"."send_status" in ('sending', 'sent', 'failed')),
	CONSTRAINT "magic_link_requests_purpose_fields_check" CHECK (("magic_link_requests"."purpose" = 'link' and "magic_link_requests"."token_identifier" is not null and "magic_link_requests"."browser_hash" is not null and "magic_link_requests"."code_hmac" is not null) or ("magic_link_requests"."purpose" = 'access_removed' and "magic_link_requests"."token_identifier" is null and "magic_link_requests"."browser_hash" is null and "magic_link_requests"."code_hmac" is null and "magic_link_requests"."pending_oauth_query" is null)),
	CONSTRAINT "magic_link_requests_send_error_check" CHECK ("magic_link_requests"."send_status" = 'failed' or ("magic_link_requests"."postmark_error_code" is null and "magic_link_requests"."postmark_http_status" is null))
);
--> statement-breakpoint
ALTER TABLE "magic_link_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "magic_link_requests" ADD CONSTRAINT "magic_link_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "magic_link_requests_email_created_at_idx" ON "magic_link_requests" USING btree ("email","created_at") WHERE "magic_link_requests"."send_status" <> 'failed';--> statement-breakpoint
CREATE INDEX "magic_link_requests_organization_created_at_idx" ON "magic_link_requests" USING btree ("organization_id","created_at") WHERE "magic_link_requests"."send_status" <> 'failed';--> statement-breakpoint
CREATE INDEX "magic_link_requests_browser_hash_idx" ON "magic_link_requests" USING btree ("browser_hash");--> statement-breakpoint
CREATE INDEX "magic_link_requests_created_at_idx" ON "magic_link_requests" USING btree ("created_at");--> statement-breakpoint
CREATE POLICY "protocol_write" ON "magic_link_requests" AS PERMISSIVE FOR ALL TO public USING (current_setting('answerable.scope', true) = 'protocol') WITH CHECK (current_setting('answerable.scope', true) = 'protocol');--> statement-breakpoint
CREATE POLICY "protocol_read" ON "magic_link_requests" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "magic_link_requests"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid));
ALTER TABLE "organization_domains" ADD COLUMN "verification_token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_domains" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD COLUMN "admission" text DEFAULT 'listed' NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_admission_check" CHECK ("sso_providers"."admission" in ('listed', 'domain'));--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_admission_kind_check" CHECK ("sso_providers"."kind" = 'magic_link' or "sso_providers"."admission" = 'listed');
CREATE TABLE "accounts" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"directory_id" text,
	"directory_user_id" text,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_issuer_account_id_unique" UNIQUE("issuer","account_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" uuid NOT NULL,
	CONSTRAINT "invitations_status_check" CHECK ("invitations"."status" in ('pending', 'accepted', 'rejected', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "members" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_organization_id_user_id_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "members_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "members_revision_check" CHECK ("members"."revision" > 0),
	CONSTRAINT "members_status_check" CHECK ("members"."status" in ('active', 'revoked')),
	CONSTRAINT "members_revoked_check" CHECK (("members"."status" = 'revoked') = ("members"."revoked_at" is not null)),
	CONSTRAINT "members_window_check" CHECK ("members"."valid_from" < "members"."valid_until")
);
--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authorization_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_revision_check" CHECK ("organizations"."revision" > 0),
	CONSTRAINT "organizations_authorization_version_check" CHECK ("organizations"."authorization_version" > 0),
	CONSTRAINT "organizations_slug_normalized_check" CHECK ("organizations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'disabled')),
	CONSTRAINT "organizations_disabled_check" CHECK (("organizations"."status" = 'disabled') = ("organizations"."disabled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"authentication_organization_id" uuid,
	"authentication_provider_id" uuid,
	"authentication_provider_revision" integer,
	"authentication_account_id" uuid,
	"upstream_auth_time" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"active_organization_id" uuid,
	CONSTRAINT "sessions_token_unique" UNIQUE("token"),
	CONSTRAINT "sessions_upstream_auth_time_check" CHECK ("sessions"."upstream_auth_time" is null or ("sessions"."authentication_account_id" is not null and "sessions"."upstream_auth_time" >= timestamp with time zone '1970-01-01 00:00:00+00' and "sessions"."upstream_auth_time" <= "sessions"."created_at")),
	CONSTRAINT "sessions_authentication_origin_check" CHECK (
      ("sessions"."authentication_organization_id" is null and "sessions"."authentication_provider_id" is null and "sessions"."authentication_provider_revision" is null)
      or ("sessions"."authentication_organization_id" is not null and "sessions"."authentication_provider_id" is not null and "sessions"."authentication_provider_revision" is not null and "sessions"."authentication_provider_revision" > 0)
    )
);
--> statement-breakpoint
CREATE TABLE "users" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"status" text DEFAULT 'inert' NOT NULL,
	"disabled_at" timestamp with time zone,
	"retired_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('inert', 'active', 'disabled')),
	CONSTRAINT "users_email_normalized_check" CHECK ("users"."email" = lower(btrim("users"."email"))),
	CONSTRAINT "users_disabled_check" CHECK (("users"."status" = 'disabled') = ("users"."disabled_at" is not null)),
	CONSTRAINT "users_retired_email_check" CHECK (("users"."retired_email" is null or "users"."status" = 'disabled') and (("users"."retired_email" is not null) = ("users"."email" = "users"."id"::text || '@retired.invalid')))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" uuid,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	CONSTRAINT "oauth_access_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resources" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"reference_id" text,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false NOT NULL,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[],
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"disabled" boolean DEFAULT false NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"authorization_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "oauth_clients_revision_check" CHECK ("oauth_clients"."revision" > 0),
	CONSTRAINT "oauth_clients_authorization_version_check" CHECK ("oauth_clients"."authorization_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "oauth_consents" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" uuid,
	"user_id" uuid NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	CONSTRAINT "oauth_refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resources" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"classification" text DEFAULT 'platform_shared' NOT NULL,
	"organization_id" uuid,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_resources_identifier_unique" UNIQUE("identifier"),
	CONSTRAINT "oauth_resources_ownership_check" CHECK (("oauth_resources"."classification" = 'platform_shared' and "oauth_resources"."organization_id" is null) or ("oauth_resources"."classification" = 'tenant_owned' and "oauth_resources"."organization_id" is not null)),
	CONSTRAINT "oauth_resources_revision_check" CHECK ("oauth_resources"."revision" > 0),
	CONSTRAINT "oauth_resources_identity_claims_check" CHECK (NOT ("oauth_resources"."custom_claims" ?| ARRAY['client_instance', 'organization_id', 'authorization_version', 'organization_authorization_version', 'subject_type', 'membership_id', 'grant_id', 'resource_instance', 'upstream_auth_time']))
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid,
	"group_id" uuid,
	"client_id" text,
	"resource" text,
	"scopes" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "entitlements_revision_check" CHECK ("entitlements"."revision" > 0),
	CONSTRAINT "entitlements_principal_check" CHECK (num_nonnulls("entitlements"."member_id", "entitlements"."group_id") <= 1),
	CONSTRAINT "entitlements_target_check" CHECK (num_nonnulls("entitlements"."client_id", "entitlements"."resource") >= 1),
	CONSTRAINT "entitlements_status_check" CHECK ("entitlements"."status" in ('active', 'disabled')),
	CONSTRAINT "entitlements_window_check" CHECK ("entitlements"."valid_from" < "entitlements"."valid_until"),
	CONSTRAINT "entitlements_scopes_check" CHECK (cardinality("entitlements"."scopes") > 0 and array_position("entitlements"."scopes", '') is null)
);
--> statement-breakpoint
ALTER TABLE "entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "group_members" (
	"deleted_at" timestamp with time zone,
	"organization_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "group_members_pkey" PRIMARY KEY("id"),
	CONSTRAINT "group_members_revision_check" CHECK ("group_members"."revision" > 0),
	CONSTRAINT "group_members_window_check" CHECK ("group_members"."valid_from" < "group_members"."valid_until")
);
--> statement-breakpoint
ALTER TABLE "group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "groups" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "groups_organization_id_slug_unique" UNIQUE("organization_id","slug"),
	CONSTRAINT "groups_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "groups_revision_check" CHECK ("groups"."revision" > 0),
	CONSTRAINT "groups_slug_normalized_check" CHECK ("groups"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "groups_status_check" CHECK ("groups"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_domains" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_domains_status_check" CHECK ("organization_domains"."status" in ('active', 'disabled')),
	CONSTRAINT "organization_domains_domain_normalized_check" CHECK ("organization_domains"."domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);
--> statement-breakpoint
ALTER TABLE "organization_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" uuid,
	"provider_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sso_providers_provider_id_unique" UNIQUE("provider_id"),
	CONSTRAINT "sso_providers_revision_check" CHECK ("sso_providers"."revision" > 0),
	CONSTRAINT "sso_providers_domain_normalized_check" CHECK ("sso_providers"."domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);
--> statement-breakpoint
ALTER TABLE "sso_providers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_event_subjects" (
	"event_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"relationship" text NOT NULL,
	"organization_id" uuid,
	"provenance" text DEFAULT 'recorded' NOT NULL,
	CONSTRAINT "audit_event_subjects_pkey" PRIMARY KEY("event_id","entity_type","entity_id","relationship"),
	CONSTRAINT "audit_event_subjects_provenance_check" CHECK ("audit_event_subjects"."provenance" in ('recorded', 'legacy_derived'))
);
--> statement-breakpoint
ALTER TABLE "audit_event_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"organization_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"outcome" text NOT NULL,
	"reason" text,
	"request_id" text,
	"ip" text,
	"user_agent" text,
	"data" jsonb,
	"operation_id" uuid,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" in ('user', 'client', 'system')),
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" in ('success', 'failure', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "system_bindings" (
	"name" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "system_bindings_name_check" CHECK ("system_bindings"."name" in ('platform'))
);
--> statement-breakpoint
CREATE TABLE "admin_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_instance" text NOT NULL,
	"authority_scope" text NOT NULL,
	"name" text NOT NULL,
	"key_digest" text NOT NULL,
	"fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"status_code" integer NOT NULL,
	"result_reference" jsonb NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_operations_key_unique" UNIQUE("actor_instance","authority_scope","name","key_digest"),
	CONSTRAINT "admin_operations_outcome_check" CHECK ("admin_operations"."outcome" in ('applied', 'noop'))
);
--> statement-breakpoint
CREATE TABLE "organization_capabilities" (
	"deleted_at" timestamp with time zone,
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
	CONSTRAINT "organization_capabilities_revision_check" CHECK ("organization_capabilities"."revision" > 0),
	CONSTRAINT "organization_capabilities_kind_check" CHECK ("organization_capabilities"."grant_kind" in ('admin_session', 'authorization_code', 'refresh_token', 'client_credentials')),
	CONSTRAINT "organization_capabilities_status_check" CHECK ("organization_capabilities"."status" in ('active', 'disabled')),
	CONSTRAINT "organization_capabilities_target_check" CHECK (
    ("organization_capabilities"."grant_kind" = 'admin_session' and "organization_capabilities"."client_id" is null and "organization_capabilities"."resource" is not null)
    or ("organization_capabilities"."grant_kind" in ('authorization_code', 'refresh_token') and "organization_capabilities"."client_id" is not null)
    or ("organization_capabilities"."grant_kind" = 'client_credentials' and "organization_capabilities"."client_id" is not null and "organization_capabilities"."resource" is not null)),
	CONSTRAINT "organization_capabilities_scopes_check" CHECK (cardinality("organization_capabilities"."scopes") > 0 and array_position("organization_capabilities"."scopes", '') is null and array_position("organization_capabilities"."scopes", null) is null),
	CONSTRAINT "organization_capabilities_window_check" CHECK ("organization_capabilities"."valid_from" < "organization_capabilities"."valid_until")
);
--> statement-breakpoint
ALTER TABLE "organization_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "grant_contexts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_instance_id" uuid NOT NULL,
	"resource_instance_id" uuid,
	"authorization_code_id" text,
	"authentication_session_id" uuid NOT NULL,
	"auth_time" timestamp with time zone NOT NULL,
	"authentication" jsonb,
	"requested_scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "grant_contexts_authorization_code_id_unique" UNIQUE("authorization_code_id"),
	CONSTRAINT "grant_contexts_code_check" CHECK ("grant_contexts"."authorization_code_id" is null or length("grant_contexts"."authorization_code_id") > 0),
	CONSTRAINT "grant_contexts_expiry_check" CHECK ("grant_contexts"."expires_at" > "grant_contexts"."created_at"),
	CONSTRAINT "grant_contexts_scopes_check" CHECK (cardinality("grant_contexts"."requested_scopes") > 0 and array_position("grant_contexts"."requested_scopes", '') is null and array_position("grant_contexts"."requested_scopes", null) is null)
);
--> statement-breakpoint
ALTER TABLE "grant_contexts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_refresh_id_oauth_refresh_tokens_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resources"("identifier") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_resources" ADD CONSTRAINT "oauth_resources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_resource_oauth_resources_identifier_fk" FOREIGN KEY ("resource") REFERENCES "public"."oauth_resources"("identifier") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_organization_id_member_id_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "public"."members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_organization_id_group_id_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "public"."groups"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_organization_id_group_id_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "public"."groups"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_organization_id_member_id_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "public"."members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event_subjects" ADD CONSTRAINT "audit_event_subjects_event_id_audit_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."audit_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_operation_id_admin_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."admin_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_bindings" ADD CONSTRAINT "system_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_bindings" ADD CONSTRAINT "system_bindings_resource_id_oauth_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_bindings" ADD CONSTRAINT "system_bindings_organization_group_fk" FOREIGN KEY ("organization_id","group_id") REFERENCES "public"."groups"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_resource_fk" FOREIGN KEY ("resource") REFERENCES "public"."oauth_resources"("identifier") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_client_instance_id_oauth_clients_id_fk" FOREIGN KEY ("client_instance_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_contexts" ADD CONSTRAINT "grant_contexts_resource_instance_id_oauth_resources_id_fk" FOREIGN KEY ("resource_instance_id") REFERENCES "public"."oauth_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_issuer_directory_user_id_idx" ON "accounts" USING btree ("issuer","directory_user_id") WHERE "accounts"."directory_user_id" is not null;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitations_organization_id_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_inviter_id_idx" ON "invitations" USING btree ("inviter_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "members_user_id_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_active_organization_id_idx" ON "sessions" USING btree ("active_organization_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_at_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_expires_at_idx" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_client_id_idx" ON "oauth_access_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_session_id_idx" ON "oauth_access_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_user_id_idx" ON "oauth_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_authorization_code_id_idx" ON "oauth_access_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_refresh_id_idx" ON "oauth_access_tokens" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauth_client_assertions_expires_at_idx" ON "oauth_client_assertions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_resources_client_id_resource_id_unique" ON "oauth_client_resources" USING btree ("client_id","resource_id") WHERE "oauth_client_resources"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "oauth_client_resources_resource_id_idx" ON "oauth_client_resources" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_user_id_idx" ON "oauth_clients" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_organization_id_idx" ON "oauth_clients" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "oauth_consents_client_id_idx" ON "oauth_consents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consents_user_id_idx" ON "oauth_consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_expires_at_idx" ON "oauth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_client_id_idx" ON "oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_session_id_idx" ON "oauth_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_user_id_idx" ON "oauth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_authorization_code_id_idx" ON "oauth_refresh_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_resources_organization_id_idx" ON "oauth_resources" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_principal_target_unique" ON "entitlements" USING btree ("organization_id","member_id","group_id","client_id","resource") WHERE "entitlements"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "entitlements_client_id_idx" ON "entitlements" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "entitlements_resource_idx" ON "entitlements" USING btree ("resource");--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_live_assignment_unique" ON "group_members" USING btree ("group_id","member_id") WHERE "group_members"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "group_members_member_id_idx" ON "group_members" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_organization_id_external_id_idx" ON "groups" USING btree ("organization_id","external_id") WHERE "groups"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_domains_organization_id_domain_unique" ON "organization_domains" USING btree ("organization_id","domain") WHERE "organization_domains"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_domains_active_domain_idx" ON "organization_domains" USING btree ("domain") WHERE "organization_domains"."status" = 'active' and "organization_domains"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_providers_organization_id_unique" ON "sso_providers" USING btree ("organization_id") WHERE "sso_providers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "audit_event_subjects_entity_idx" ON "audit_event_subjects" USING btree ("entity_type","entity_id","event_id");--> statement-breakpoint
CREATE INDEX "audit_event_subjects_tenant_entity_idx" ON "audit_event_subjects" USING btree ("organization_id","entity_type","entity_id","event_id");--> statement-breakpoint
CREATE INDEX "audit_events_organization_id_id_idx" ON "audit_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_operation_id_idx" ON "audit_events" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "audit_events_action_occurred_at_idx" ON "audit_events" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_capabilities_target_kind_unique" ON "organization_capabilities" USING btree ("organization_id","client_id","resource","grant_kind") WHERE "organization_capabilities"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "grant_contexts_organization_id_idx" ON "grant_contexts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_member_id_idx" ON "grant_contexts" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_user_id_idx" ON "grant_contexts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_client_instance_id_idx" ON "grant_contexts" USING btree ("client_instance_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_resource_instance_id_idx" ON "grant_contexts" USING btree ("resource_instance_id");--> statement-breakpoint
CREATE POLICY "tenant_write" ON "invitations" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "invitations"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "invitations"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_read" ON "invitations" AS PERMISSIVE FOR SELECT TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "invitations"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
      or current_setting('answerable.scope', true) in ('platform-read', 'platform-users')
      or (current_setting('answerable.scope', true) = 'tenant-read' and "invitations"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
      or false
      or (current_setting('answerable.scope', true) = 'policy-root' and "invitations"."organization_id" in (select organization_id from system_bindings)));--> statement-breakpoint
CREATE POLICY "tenant_write" ON "members" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_read" ON "members" AS PERMISSIVE FOR SELECT TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
      or current_setting('answerable.scope', true) in ('platform-read', 'platform-users')
      or (current_setting('answerable.scope', true) = 'tenant-read' and "members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
      or (current_setting('answerable.scope', true) in ('policy-user', 'grant-admission') and "members"."user_id" = nullif(current_setting('answerable.subject', true), '')::uuid)
      or (current_setting('answerable.scope', true) = 'policy-root' and "members"."organization_id" in (select organization_id from system_bindings)));--> statement-breakpoint
CREATE POLICY "tenant_write" ON "entitlements" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "entitlements"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "entitlements"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_read" ON "entitlements" AS PERMISSIVE FOR SELECT TO public USING (((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "entitlements"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
    or current_setting('answerable.scope', true) = 'platform-read'
    or (current_setting('answerable.scope', true) = 'tenant-read' and "entitlements"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (current_setting('answerable.scope', true) = 'policy-user' and "entitlements"."organization_id" in (
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid and deleted_at is null and status = 'active' and (valid_from is null or valid_from <= statement_timestamp()) and (valid_until is null or valid_until > statement_timestamp())
    ))
    or (current_setting('answerable.scope', true) = 'policy-root' and "entitlements"."organization_id" in (select organization_id from system_bindings))));--> statement-breakpoint
CREATE POLICY "tenant_write" ON "group_members" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "group_members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "group_members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_read" ON "group_members" AS PERMISSIVE FOR SELECT TO public USING (((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "group_members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
    or current_setting('answerable.scope', true) = 'platform-read'
    or (current_setting('answerable.scope', true) = 'tenant-read' and "group_members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (current_setting('answerable.scope', true) = 'policy-user' and "group_members"."organization_id" in (
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid and deleted_at is null and status = 'active' and (valid_from is null or valid_from <= statement_timestamp()) and (valid_until is null or valid_until > statement_timestamp())
    ))
    or (current_setting('answerable.scope', true) = 'policy-root' and "group_members"."organization_id" in (select organization_id from system_bindings))));--> statement-breakpoint
CREATE POLICY "tenant_write" ON "groups" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "groups"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "groups"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_read" ON "groups" AS PERMISSIVE FOR SELECT TO public USING (((current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'tenant-write' and "groups"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
    or current_setting('answerable.scope', true) = 'platform-read'
    or (current_setting('answerable.scope', true) = 'tenant-read' and "groups"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (current_setting('answerable.scope', true) = 'policy-user' and "groups"."organization_id" in (
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid and deleted_at is null and status = 'active' and (valid_from is null or valid_from <= statement_timestamp()) and (valid_until is null or valid_until > statement_timestamp())
    ))
    or (current_setting('answerable.scope', true) = 'policy-root' and "groups"."organization_id" in (select organization_id from system_bindings))));--> statement-breakpoint
CREATE POLICY "routing_read" ON "organization_domains" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "routing_write" ON "organization_domains" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write'
    or (current_setting('answerable.scope', true) = 'tenant-write' and "organization_domains"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (false and current_setting('answerable.scope', true) = 'protocol'))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write'
    or (current_setting('answerable.scope', true) = 'tenant-write' and "organization_domains"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (false and current_setting('answerable.scope', true) = 'protocol')));--> statement-breakpoint
CREATE POLICY "routing_read" ON "sso_providers" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "routing_write" ON "sso_providers" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write'
    or (current_setting('answerable.scope', true) = 'tenant-write' and "sso_providers"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (true and current_setting('answerable.scope', true) = 'protocol'))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write'
    or (current_setting('answerable.scope', true) = 'tenant-write' and "sso_providers"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (true and current_setting('answerable.scope', true) = 'protocol')));--> statement-breakpoint
CREATE POLICY "audit_insert" ON "audit_event_subjects" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "audit_read" ON "audit_event_subjects" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write', 'platform-users')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "audit_event_subjects"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "audit_insert" ON "audit_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "audit_read" ON "audit_events" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write', 'platform-users')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "audit_events"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "capability_write" ON "organization_capabilities" AS PERMISSIVE FOR ALL TO public USING (current_setting('answerable.scope', true) = 'platform-write') WITH CHECK (current_setting('answerable.scope', true) = 'platform-write');--> statement-breakpoint
CREATE POLICY "capability_read" ON "organization_capabilities" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "organization_capabilities"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
      or (current_setting('answerable.scope', true) = 'policy-user' and "organization_capabilities"."organization_id" in (select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid and deleted_at is null and status = 'active' and (valid_from is null or valid_from <= statement_timestamp()) and (valid_until is null or valid_until > statement_timestamp())))
      or (current_setting('answerable.scope', true) = 'policy-root' and "organization_capabilities"."organization_id" in (select organization_id from system_bindings)));--> statement-breakpoint
CREATE POLICY "grant_read" ON "grant_contexts" AS PERMISSIVE FOR SELECT TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'platform-users') or (current_setting('answerable.scope', true) = 'tenant-write' and "grant_contexts"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid) or (current_setting('answerable.scope', true) = 'grant-client' and "grant_contexts"."client_instance_id" in (select id from oauth_clients where client_id = current_setting('answerable.client', true)))) or current_setting('answerable.scope', true) = 'platform-read' or (current_setting('answerable.scope', true) = 'tenant-read' and "grant_contexts"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid) or (current_setting('answerable.scope', true) = 'policy-user' and "grant_contexts"."user_id" = nullif(current_setting('answerable.subject', true), '')::uuid) or (current_setting('answerable.scope', true) = 'grant-admission' and "grant_contexts"."user_id" = nullif(current_setting('answerable.subject', true), '')::uuid and "grant_contexts"."authentication_session_id" = nullif(current_setting('answerable.session', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "grant_insert" ON "grant_contexts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'grant-admission' and "grant_contexts"."user_id" = nullif(current_setting('answerable.subject', true), '')::uuid and "grant_contexts"."authentication_session_id" = nullif(current_setting('answerable.session', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "grant_update" ON "grant_contexts" AS PERMISSIVE FOR UPDATE TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'platform-users') or (current_setting('answerable.scope', true) = 'tenant-write' and "grant_contexts"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid) or (current_setting('answerable.scope', true) = 'grant-client' and "grant_contexts"."client_instance_id" in (select id from oauth_clients where client_id = current_setting('answerable.client', true))))) WITH CHECK ((current_setting('answerable.scope', true) in ('platform-write', 'platform-users') or (current_setting('answerable.scope', true) = 'tenant-write' and "grant_contexts"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid) or (current_setting('answerable.scope', true) = 'grant-client' and "grant_contexts"."client_instance_id" in (select id from oauth_clients where client_id = current_setting('answerable.client', true)))));--> statement-breakpoint
CREATE POLICY "grant_delete" ON "grant_contexts" AS PERMISSIVE FOR DELETE TO public USING (current_setting('answerable.scope', true) = 'platform-write');
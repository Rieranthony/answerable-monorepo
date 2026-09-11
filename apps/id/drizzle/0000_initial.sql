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
CREATE TABLE "security_identifiers" (
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"instance_id" uuid NOT NULL,
	CONSTRAINT "security_identifiers_kind_identifier_pk" PRIMARY KEY("kind","identifier"),
	CONSTRAINT "security_identifiers_kind_instance_unique" UNIQUE("kind","instance_id"),
	CONSTRAINT "security_identifiers_kind_check" CHECK ("security_identifiers"."kind" in ('client', 'resource'))
);
--> statement-breakpoint
CREATE TABLE "system_bindings" (
	"name" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "system_bindings_name_check" CHECK ("system_bindings"."name" in ('platform'))
);
--> statement-breakpoint
CREATE TABLE "admin_operation_results" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL
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
	"replay_expires_at" timestamp with time zone,
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
ALTER TABLE "admin_operation_results" ADD CONSTRAINT "admin_operation_results_operation_id_admin_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."admin_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "oauth_refresh_tokens_client_id_idx" ON "oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_session_id_idx" ON "oauth_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_user_id_idx" ON "oauth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_authorization_code_id_idx" ON "oauth_refresh_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_resources_organization_id_idx" ON "oauth_resources" USING btree ("organization_id");--> statement-breakpoint
-- Drizzle does not model NULLS NOT DISTINCT on partial indexes. Preserve null-target uniqueness.
CREATE UNIQUE INDEX "entitlements_principal_target_unique" ON "entitlements" USING btree ("organization_id","member_id","group_id","client_id","resource") NULLS NOT DISTINCT WHERE "entitlements"."deleted_at" is null;--> statement-breakpoint
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
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
-- The bound platform ceiling must remain unique even with a null client.
CREATE UNIQUE INDEX "organization_capabilities_target_kind_unique" ON "organization_capabilities" USING btree ("organization_id","client_id","resource","grant_kind") NULLS NOT DISTINCT WHERE "organization_capabilities"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "grant_contexts_member_id_idx" ON "grant_contexts" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_user_id_idx" ON "grant_contexts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_client_instance_id_idx" ON "grant_contexts" USING btree ("client_instance_id");--> statement-breakpoint
CREATE INDEX "grant_contexts_resource_instance_id_idx" ON "grant_contexts" USING btree ("resource_instance_id");--> statement-breakpoint
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
CREATE POLICY "capability_write" ON "organization_capabilities" AS PERMISSIVE FOR ALL TO public USING (current_setting('answerable.scope', true) = 'platform-write') WITH CHECK (current_setting('answerable.scope', true) = 'platform-write');--> statement-breakpoint
CREATE POLICY "capability_read" ON "organization_capabilities" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "organization_capabilities"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
      or (current_setting('answerable.scope', true) = 'policy-user' and "organization_capabilities"."organization_id" in (select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid and deleted_at is null and status = 'active' and (valid_from is null or valid_from <= statement_timestamp()) and (valid_until is null or valid_until > statement_timestamp())))
      or (current_setting('answerable.scope', true) = 'policy-root' and "organization_capabilities"."organization_id" in (select organization_id from system_bindings)));--> statement-breakpoint
CREATE POLICY "grant_read" ON "grant_contexts" AS PERMISSIVE FOR SELECT TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'platform-users') or (current_setting('answerable.scope', true) = 'tenant-write' and "grant_contexts"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid) or (current_setting('answerable.scope', true) = 'grant-client' and "grant_contexts"."client_instance_id" in (select id from oauth_clients where client_id = current_setting('answerable.client', true)))) or current_setting('answerable.scope', true) = 'platform-read' or (current_setting('answerable.scope', true) = 'tenant-read' and "grant_contexts"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid) or (current_setting('answerable.scope', true) = 'policy-user' and "grant_contexts"."user_id" = nullif(current_setting('answerable.subject', true), '')::uuid) or (current_setting('answerable.scope', true) = 'grant-admission' and "grant_contexts"."user_id" = nullif(current_setting('answerable.subject', true), '')::uuid and "grant_contexts"."authentication_session_id" = nullif(current_setting('answerable.session', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "grant_insert" ON "grant_contexts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('answerable.scope', true) = 'platform-write' or (current_setting('answerable.scope', true) = 'grant-admission' and "grant_contexts"."user_id" = nullif(current_setting('answerable.subject', true), '')::uuid and "grant_contexts"."authentication_session_id" = nullif(current_setting('answerable.session', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "grant_update" ON "grant_contexts" AS PERMISSIVE FOR UPDATE TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'platform-users') or (current_setting('answerable.scope', true) = 'tenant-write' and "grant_contexts"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid) or (current_setting('answerable.scope', true) = 'grant-client' and "grant_contexts"."client_instance_id" in (select id from oauth_clients where client_id = current_setting('answerable.client', true))))) WITH CHECK ((current_setting('answerable.scope', true) in ('platform-write', 'platform-users') or (current_setting('answerable.scope', true) = 'tenant-write' and "grant_contexts"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid) or (current_setting('answerable.scope', true) = 'grant-client' and "grant_contexts"."client_instance_id" in (select id from oauth_clients where client_id = current_setting('answerable.client', true)))));--> statement-breakpoint
CREATE POLICY "grant_delete" ON "grant_contexts" AS PERMISSIVE FOR DELETE TO public USING (current_setting('answerable.scope', true) = 'platform-write');
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_domains" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sso_providers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_event_subjects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_expires_at_idx" ON "oauth_access_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_expires_at_idx" ON "oauth_refresh_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "audit_events_action_occurred_at_idx" ON "audit_events" USING btree ("action","occurred_at");
--> statement-breakpoint
CREATE INDEX "grant_contexts_organization_id_idx" ON "grant_contexts" USING btree ("organization_id");
--> statement-breakpoint
CREATE POLICY "tenant_write" ON "invitations" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "invitations"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "invitations"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "invitations" AS PERMISSIVE FOR SELECT TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "invitations"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
      or current_setting('answerable.scope', true) in ('platform-read', 'platform-users')
      or (current_setting('answerable.scope', true) = 'tenant-read' and "invitations"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
      or false
      or (current_setting('answerable.scope', true) = 'policy-root' and "invitations"."organization_id" in (select organization_id from system_bindings)));
--> statement-breakpoint
CREATE POLICY "tenant_write" ON "members" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))) WITH CHECK ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)));
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "members" AS PERMISSIVE FOR SELECT TO public USING ((current_setting('answerable.scope', true) in ('platform-write', 'protocol') or (current_setting('answerable.scope', true) = 'tenant-write' and "members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid))
      or current_setting('answerable.scope', true) in ('platform-read', 'platform-users')
      or (current_setting('answerable.scope', true) = 'tenant-read' and "members"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
      or (current_setting('answerable.scope', true) in ('policy-user', 'grant-admission') and "members"."user_id" = nullif(current_setting('answerable.subject', true), '')::uuid)
      or (current_setting('answerable.scope', true) = 'policy-root' and "members"."organization_id" in (select organization_id from system_bindings)));
--> statement-breakpoint
CREATE POLICY "routing_read" ON "organization_domains" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
CREATE POLICY "routing_write" ON "organization_domains" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write'
    or (current_setting('answerable.scope', true) = 'tenant-write' and "organization_domains"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (false and current_setting('answerable.scope', true) = 'protocol'))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write'
    or (current_setting('answerable.scope', true) = 'tenant-write' and "organization_domains"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (false and current_setting('answerable.scope', true) = 'protocol')));
--> statement-breakpoint
CREATE POLICY "routing_read" ON "sso_providers" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
CREATE POLICY "routing_write" ON "sso_providers" AS PERMISSIVE FOR ALL TO public USING ((current_setting('answerable.scope', true) = 'platform-write'
    or (current_setting('answerable.scope', true) = 'tenant-write' and "sso_providers"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (true and current_setting('answerable.scope', true) = 'protocol'))) WITH CHECK ((current_setting('answerable.scope', true) = 'platform-write'
    or (current_setting('answerable.scope', true) = 'tenant-write' and "sso_providers"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (true and current_setting('answerable.scope', true) = 'protocol')));
--> statement-breakpoint
CREATE POLICY "audit_insert" ON "audit_event_subjects" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "audit_read" ON "audit_event_subjects" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write', 'platform-users')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "audit_event_subjects"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "audit_insert" ON "audit_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "audit_read" ON "audit_events" AS PERMISSIVE FOR SELECT TO public USING (current_setting('answerable.scope', true) in ('platform-read', 'platform-write', 'platform-users')
      or (current_setting('answerable.scope', true) in ('tenant-read', 'tenant-write') and "audit_events"."organization_id" = nullif(current_setting('answerable.tenant', true), '')::uuid));
--> statement-breakpoint

-- Custom database invariants. Drizzle models the tables and policies above;
-- functions, triggers, deferred checking and execution restrictions are reviewed here.
ALTER TABLE "audit_events" ALTER CONSTRAINT "audit_events_operation_id_admin_operations_id_fk" DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION protect_oauth_client_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Client identity and ownership are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_clients_identity_immutable';
  END IF;
  IF NEW.authorization_version < OLD.authorization_version THEN
    RAISE EXCEPTION 'Client authorization version cannot decrease'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_clients_version_monotonic';
  END IF;
  IF NEW.client_secret IS DISTINCT FROM OLD.client_secret
     OR NEW.jwks IS DISTINCT FROM OLD.jwks
     OR NEW.jwks_uri IS DISTINCT FROM OLD.jwks_uri
     OR NEW.token_endpoint_auth_method IS DISTINCT FROM OLD.token_endpoint_auth_method
     OR (NEW.disabled AND NOT OLD.disabled) THEN
    NEW.authorization_version := greatest(NEW.authorization_version, OLD.authorization_version + 1);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_oauth_resource_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.identifier IS DISTINCT FROM OLD.identifier THEN
    RAISE EXCEPTION 'Resource identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'oauth_resources_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION reserve_security_identifier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'oauth_clients' THEN
    INSERT INTO public.security_identifiers (kind, identifier, instance_id)
    VALUES ('client', NEW.client_id, NEW.id);
  ELSE
    INSERT INTO public.security_identifiers (kind, identifier, instance_id)
    VALUES ('resource', NEW.identifier, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_security_identifier() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Security identifier reservations are permanent'
    USING ERRCODE = '23514', CONSTRAINT = 'security_identifiers_immutable';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_system_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'System bindings are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'system_bindings_immutable';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION try_uuid(value text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION capture_audit_subjects(event public.audit_events, origin text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE related_user text; user_effects jsonb; entitlement_state jsonb;
BEGIN
  INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
  VALUES (event.id, event.actor_type, event.actor_id, 'actor', event.organization_id, origin);
  IF event.target_id IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, event.target_type, event.target_id, 'target', event.organization_id, origin);
  END IF;
  IF event.target_type = 'entitlement' THEN
    entitlement_state := CASE WHEN event.action = 'entitlement.created'
      THEN event.data->'after' ELSE event.data->'before' END;
  END IF;
  IF event.target_type IN ('member', 'group_member') THEN
    SELECT user_id::text INTO related_user FROM public.members
    WHERE id = public.try_uuid(event.target_id) AND (event.organization_id IS NULL OR organization_id = event.organization_id);
    related_user := coalesce(related_user, event.data->>'userId');
  ELSIF (event.schema_version = 1 OR (event.schema_version = 3 AND event.action = 'entitlement.removed' AND event.data->>'deletionMode' = 'soft')) AND event.outcome = 'success'
    AND event.organization_id IS NOT NULL AND event.target_type = 'entitlement'
    AND event.target_id IS NOT NULL AND event.action IN (
      'entitlement.created', 'entitlement.updated', 'entitlement.update_unchanged',
      'entitlement.enabled', 'entitlement.disabled', 'entitlement.enable_unchanged',
      'entitlement.disable_unchanged', 'entitlement.removed'
    ) THEN
    SELECT user_id::text INTO related_user FROM public.members
    WHERE id = public.try_uuid(entitlement_state->>'memberId')
      AND organization_id = event.organization_id
      AND entitlement_state->>'organizationId' = event.organization_id::text
      AND entitlement_state->>'id' = event.target_id;
  ELSIF event.target_type = 'session' THEN
    SELECT user_id::text INTO related_user FROM public.sessions WHERE id = public.try_uuid(event.target_id);
    related_user := coalesce(related_user, event.data->>'userId');
  END IF;
  IF related_user IS NOT NULL THEN
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (event.id, 'user', related_user, 'affected', event.organization_id, origin);
  END IF;
  user_effects := CASE
    WHEN event.schema_version = 3 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NULL AND event.target_type = 'user' AND event.action = 'user.erased'
      AND event.data->'before'->>'id' = event.target_id AND event.data->'after'->>'id' = event.target_id
      AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN (CASE WHEN jsonb_typeof(event.data->'revokedGrantContexts') = 'array' THEN event.data->'revokedGrantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedAccessTokens') = 'array' THEN event.data->'effects'->'deletedAccessTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedRefreshTokens') = 'array' THEN event.data->'effects'->'deletedRefreshTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'softDeletedConsents') = 'array' THEN event.data->'effects'->'softDeletedConsents' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedAccessTokenSessions') = 'array' THEN event.data->'effects'->'clearedAccessTokenSessions' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedRefreshTokenSessions') = 'array' THEN event.data->'effects'->'clearedRefreshTokenSessions' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 3 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NOT NULL AND event.target_type = 'organization' AND event.action = 'organization.erased'
      AND event.target_id = event.organization_id::text AND event.data->'after'->>'id' = event.target_id
      AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN (CASE WHEN jsonb_typeof(event.data->'revokedGrantContexts') = 'array' THEN event.data->'revokedGrantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'softDeletedMembers') = 'array' THEN event.data->'effects'->'softDeletedMembers' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedSessionSelections') = 'array' THEN event.data->'effects'->'clearedSessionSelections' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 3 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NOT NULL AND event.target_type = 'group' AND event.action = 'group.erased'
      AND event.data->'after'->>'id' = event.target_id AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN event.data->'effects'->'softDeletedAssignments'
    WHEN event.schema_version = 3 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NULL AND event.target_type = 'client' AND event.action = 'client.grants_erased'
      AND event.target_id IS NOT NULL AND jsonb_typeof(event.data->'clientInstanceId') = 'string'
      AND event.data->>'clientInstanceId' <> ''
      THEN (CASE WHEN jsonb_typeof(event.data->'grantContexts') = 'array' THEN event.data->'grantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedAccessTokens') = 'array' THEN event.data->'effects'->'deletedAccessTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedRefreshTokens') = 'array' THEN event.data->'effects'->'deletedRefreshTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'softDeletedConsents') = 'array' THEN event.data->'effects'->'softDeletedConsents' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 2 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NULL AND event.target_type = 'resource' AND event.action = 'resource.erased'
      AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN event.data->'revokedGrantContexts'
    WHEN event.schema_version = 2 AND event.outcome = 'success' AND event.data->>'deletionMode' = 'soft'
      AND event.organization_id IS NOT NULL AND event.target_type = 'sso_provider' AND event.action = 'sso_provider.deleted'
      AND event.data->'after'->>'deletedAt' IS NOT NULL
      THEN event.data->'effects'->'revokedGrantContexts'
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NULL AND event.target_type = 'user'
      AND event.target_id IS NOT NULL AND event.action = 'user.erased'
      AND event.data->'before'->>'id' = event.target_id
      THEN
        (CASE WHEN jsonb_typeof(event.data->'deletedGrantContexts') = 'array' THEN event.data->'deletedGrantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedAccessTokens') = 'array' THEN event.data->'effects'->'deletedAccessTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedRefreshTokens') = 'array' THEN event.data->'effects'->'deletedRefreshTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedConsents') = 'array' THEN event.data->'effects'->'deletedConsents' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedAccessTokenSessions') = 'array' THEN event.data->'effects'->'clearedAccessTokenSessions' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedRefreshTokenSessions') = 'array' THEN event.data->'effects'->'clearedRefreshTokenSessions' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NOT NULL AND event.target_type = 'organization'
      AND event.target_id = event.organization_id::text AND event.action = 'organization.erased'
      THEN
        (CASE WHEN jsonb_typeof(event.data->'effects'->'removedMembers') = 'array'
          THEN event.data->'effects'->'removedMembers' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'clearedSessionSelections') = 'array'
          THEN event.data->'effects'->'clearedSessionSelections' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'deletedGrantContexts') = 'array'
          THEN event.data->'deletedGrantContexts' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NOT NULL AND event.target_type = 'group'
      AND event.target_id IS NOT NULL AND event.action = 'group.erased'
      THEN event.data->'effects'->'removedAssignments'
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NOT NULL AND event.target_type = 'group'
      AND event.target_id IS NOT NULL AND event.action IN ('group.enabled', 'group.disabled')
      THEN event.data->'policySources'->'assignments'
    WHEN (event.schema_version = 2 OR (event.schema_version = 3 AND event.action = 'entitlement.removed' AND event.data->>'deletionMode' = 'soft')) AND event.outcome = 'success'
      AND event.organization_id IS NOT NULL AND event.target_type = 'entitlement'
      AND event.target_id IS NOT NULL AND event.action IN (
        'entitlement.created', 'entitlement.updated', 'entitlement.enabled',
        'entitlement.disabled', 'entitlement.removed'
      )
      AND entitlement_state->>'id' = event.target_id
      AND entitlement_state->>'organizationId' = event.organization_id::text
      AND entitlement_state->'memberId' = 'null'::jsonb
      AND jsonb_typeof(entitlement_state->'groupId') IN ('null', 'string')
      THEN event.data->'audience'
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NULL AND event.target_type = 'client'
      AND event.target_id IS NOT NULL AND event.action = 'client.grants_revoked'
      AND jsonb_typeof(event.data->'clientInstanceId') = 'string'
      AND event.data->>'clientInstanceId' <> ''
      THEN
        (CASE WHEN jsonb_typeof(event.data->'grantContexts') = 'array' THEN event.data->'grantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'revokedTokens'->'access') = 'array' THEN event.data->'revokedTokens'->'access' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'revokedTokens'->'refresh') = 'array' THEN event.data->'revokedTokens'->'refresh' ELSE '[]'::jsonb END)
    WHEN event.schema_version = 2 AND event.outcome = 'success'
      AND event.organization_id IS NULL AND event.target_type = 'client'
      AND event.target_id IS NOT NULL AND event.action = 'client.grants_erased'
      AND jsonb_typeof(event.data->'clientInstanceId') = 'string'
      AND event.data->>'clientInstanceId' <> ''
      THEN
        (CASE WHEN jsonb_typeof(event.data->'grantContexts') = 'array' THEN event.data->'grantContexts' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedAccessTokens') = 'array' THEN event.data->'effects'->'deletedAccessTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedRefreshTokens') = 'array' THEN event.data->'effects'->'deletedRefreshTokens' ELSE '[]'::jsonb END)
        || (CASE WHEN jsonb_typeof(event.data->'effects'->'deletedConsents') = 'array' THEN event.data->'effects'->'deletedConsents' ELSE '[]'::jsonb END)
    WHEN event.schema_version <> 1 OR event.outcome <> 'success' THEN '[]'::jsonb
    WHEN event.organization_id IS NULL AND event.target_type = 'user' AND event.action = 'user.erased'
      THEN event.data->'deletedGrantContexts'
    WHEN event.organization_id IS NULL AND event.target_type = 'client'
      AND event.action IN ('client.grants_revoked', 'client.grants_erased')
      THEN event.data->'grantContexts'
    WHEN event.organization_id IS NULL AND event.target_type = 'resource' AND event.action = 'resource.disabled'
      THEN event.data->'effects'->'revokedGrantContexts'
    WHEN event.organization_id IS NULL AND event.target_type = 'resource' AND event.action = 'resource.erased'
      THEN event.data->'deletedGrantContexts'
    WHEN event.organization_id IS NOT NULL AND event.target_type = 'organization'
      AND event.target_id = event.organization_id::text AND event.action = 'organization.disabled'
      THEN event.data->'effects'->'revokedGrantContexts'
    WHEN event.organization_id IS NOT NULL AND event.target_type = 'organization'
      AND event.target_id = event.organization_id::text AND event.action = 'organization.erased'
      THEN event.data->'deletedGrantContexts'
    WHEN event.organization_id IS NOT NULL AND event.target_type = 'sso_provider'
      AND event.action IN ('sso_provider.created', 'sso_provider.updated', 'sso_provider.deleted')
      THEN event.data->'effects'->'revokedGrantContexts'
    ELSE '[]'::jsonb
  END;
  IF jsonb_typeof(user_effects) = 'array' THEN
    INSERT INTO public.audit_event_subjects
      (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    SELECT DISTINCT event.id, 'user', effect->>'userId', 'affected', event.organization_id, origin
    FROM jsonb_array_elements(user_effects) AS effects(effect)
    WHERE jsonb_typeof(effect->'userId') = 'string' AND effect->>'userId' <> ''
      AND (event.schema_version NOT IN (2, 3) OR event.target_type NOT IN ('user', 'client') OR (
        jsonb_typeof(effect->'id') = 'string' AND effect->>'id' <> ''
      ))
      AND (event.schema_version NOT IN (2, 3) OR event.target_type <> 'organization' OR (
        effect->>'organizationId' = event.organization_id::text
        AND jsonb_typeof(effect->'id') = 'string' AND effect->>'id' <> ''
      ))
      AND (event.action NOT IN ('group.erased', 'group.enabled', 'group.disabled') OR (
        effect->>'organizationId' = event.organization_id::text
        AND effect->>'groupId' = event.target_id
      ))
      AND (event.target_type <> 'entitlement' OR (
        effect->>'organizationId' = event.organization_id::text
        AND jsonb_typeof(effect->'memberId') = 'string' AND effect->>'memberId' <> ''
        AND (
          (entitlement_state->'groupId' = 'null'::jsonb AND effect->'groupAssignment' = 'null'::jsonb)
          OR (jsonb_typeof(entitlement_state->'groupId') = 'string'
            AND effect->'groupAssignment'->>'groupId' = entitlement_state->>'groupId')
        )
      ))
    ON CONFLICT (event_id, entity_type, entity_id, relationship) DO NOTHING;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION record_audit_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.capture_audit_subjects(NEW, 'recorded');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_admin_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Completed operations are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'admin_operations_immutable';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.purge_operation_results(audit_id uuid, batch_size integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  removed uuid[];
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 1000 THEN
    RAISE EXCEPTION 'Retention batch size must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  WITH candidates AS (
    SELECT result.operation_id
    FROM public.admin_operation_results result
    JOIN public.admin_operations operation ON operation.id = result.operation_id
    WHERE operation.replay_expires_at <= statement_timestamp()
    ORDER BY operation.replay_expires_at, result.operation_id
    LIMIT batch_size FOR UPDATE OF result SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.admin_operation_results result USING candidates
    WHERE result.operation_id = candidates.operation_id RETURNING result.operation_id
  )
  SELECT coalesce(array_agg(operation_id ORDER BY operation_id), '{}'::uuid[]) INTO removed FROM deleted;
  IF cardinality(removed) > 0 THEN
    INSERT INTO public.audit_events (id, actor_type, actor_id, action, target_type, outcome, data)
    VALUES (audit_id, 'system', 'operation-retention', 'operation.results_purged', 'operation_result', 'success',
      jsonb_build_object('count', cardinality(removed), 'operationIds', to_jsonb(removed)));
  END IF;
  RETURN cardinality(removed);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_configuration_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'Configuration revision is server controlled'
      USING ERRCODE = '23514', CONSTRAINT = 'configuration_revision_server_controlled';
  END IF;
  IF (to_jsonb(NEW) - 'revision') IS DISTINCT FROM (to_jsonb(OLD) - 'revision') THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION touch_client_resource_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.client_id = OLD.client_id AND NEW.resource_id = OLD.resource_id AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  FOR target IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.client_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.client_id END
    ]) AS targets(value) WHERE value IS NOT NULL ORDER BY value
  LOOP
    UPDATE public.oauth_clients
    SET updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE client_id = target;
  END LOOP;
  FOR target IN
    SELECT DISTINCT value FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.resource_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.resource_id END
    ]) AS targets(value) WHERE value IS NOT NULL ORDER BY value
  LOOP
    UPDATE public.oauth_resources
    SET updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE identifier = target;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_member_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Membership identity and tenant are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'members_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_organization_authorization_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.authorization_version < OLD.authorization_version THEN
    RAISE EXCEPTION 'Organization authorization version cannot decrease'
      USING ERRCODE = '23514', CONSTRAINT = 'organizations_version_monotonic';
  END IF;
  IF NEW.status = 'disabled' AND OLD.status <> 'disabled' THEN
    NEW.authorization_version := greatest(NEW.authorization_version, OLD.authorization_version + 1);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_group_assignment_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    RAISE EXCEPTION 'Group assignment identity and ownership are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'group_members_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_resource_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.classification IS DISTINCT FROM OLD.classification OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Resource ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_private_resource_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM oauth_resources r WHERE r.identifier = NEW.resource AND r.classification = 'tenant_owned' AND r.organization_id <> NEW.organization_id) THEN
    RAISE EXCEPTION 'Private resource belongs to another organisation' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
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
CREATE FUNCTION protect_reserved_admin_capability() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.grant_kind = 'admin_session' AND EXISTS (
    SELECT 1 FROM system_bindings b JOIN oauth_resources r ON r.id = b.resource_id
    WHERE b.organization_id = OLD.organization_id AND r.identifier = OLD.resource
  ) THEN
    RAISE EXCEPTION 'The bound platform capability cannot be removed; change its configuration explicitly'
      USING ERRCODE = '23514', CONSTRAINT = 'reserved_admin_capability';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
-- The fixed provenance guard must lock members without granting admission callers UPDATE.
CREATE FUNCTION protect_grant_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
  PERFORM 1 FROM public.members m
    JOIN public.organizations o ON o.id = m.organization_id
    JOIN public.users u ON u.id = m.user_id
    JOIN public.sessions s ON s.user_id = u.id
    JOIN public.oauth_clients c ON c.id = NEW.client_instance_id
    WHERE m.id = NEW.member_id AND m.organization_id = NEW.organization_id
      AND m.user_id = NEW.user_id AND m.status = 'active'
      AND o.status = 'active' AND u.status = 'active' AND m.deleted_at IS NULL AND o.deleted_at IS NULL AND u.deleted_at IS NULL AND c.deleted_at IS NULL
      AND s.id = NEW.authentication_session_id AND s.created_at = NEW.auth_time
      AND s.expires_at > statement_timestamp() AND c.disabled = false
      AND NEW.requested_scopes <@ c.scopes
    FOR SHARE OF m, o, u, s, c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grant authentication and membership must match'
      USING ERRCODE = '23514', CONSTRAINT = 'grant_context_provenance';
  END IF;
  IF NEW.resource_instance_id IS NOT NULL THEN
    PERFORM 1 FROM public.oauth_resources r WHERE r.id = NEW.resource_instance_id
      AND r.disabled = false AND r.deleted_at IS NULL
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
CREATE FUNCTION protect_session_authentication_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.user_id, NEW.created_at, NEW.authentication_organization_id, NEW.authentication_provider_id, NEW.authentication_provider_revision, NEW.authentication_account_id, NEW.upstream_auth_time)
      IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.created_at, OLD.authentication_organization_id, OLD.authentication_provider_id, OLD.authentication_provider_revision, OLD.authentication_account_id, OLD.upstream_auth_time) THEN
      RAISE EXCEPTION 'Session identity and authentication origin are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_immutable';
    END IF;
  ELSIF NEW.authentication_provider_id IS NOT NULL THEN
    PERFORM 1 FROM sso_providers p
      JOIN accounts a ON a.id = NEW.authentication_account_id
        AND a.user_id = NEW.user_id AND a.issuer = p.issuer
        AND a.provider_id = p.provider_id AND a.deleted_at IS NULL
      WHERE p.id = NEW.authentication_provider_id
        AND p.organization_id = NEW.authentication_organization_id
        AND p.revision = NEW.authentication_provider_revision AND p.deleted_at IS NULL
      FOR SHARE OF p, a;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session authentication origin must match its provider and account'
        USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_provider';
    END IF;
  ELSIF NEW.authentication_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Session account requires an authentication provider'
      USING ERRCODE = '23514', CONSTRAINT = 'session_authentication_origin_provider';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_sso_provider_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'Configuration revision is server controlled'
      USING ERRCODE = '23514', CONSTRAINT = 'configuration_revision_server_controlled';
  END IF;
  IF (to_jsonb(NEW) - 'revision' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revision' - 'updated_at') THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_product_deletion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Product deletion is terminal' USING ERRCODE = '23514', CONSTRAINT = 'product_deletion_terminal';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF TG_TABLE_NAME IN ('organizations', 'groups', 'oauth_resources') AND EXISTS (
      SELECT 1 FROM public.system_bindings b WHERE
        (TG_TABLE_NAME = 'organizations' AND b.organization_id = OLD.id)
        OR (TG_TABLE_NAME = 'groups' AND b.group_id = OLD.id)
        OR (TG_TABLE_NAME = 'oauth_resources' AND b.resource_id = OLD.id)
    ) THEN
      RAISE EXCEPTION 'Bound platform objects cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'system_binding_protected';
    END IF;
    IF TG_TABLE_NAME = 'organization_capabilities' AND to_jsonb(OLD)->>'grant_kind' = 'admin_session'
      AND EXISTS (SELECT 1 FROM public.system_bindings WHERE organization_id = (to_jsonb(OLD)->>'organization_id')::uuid) THEN
      RAISE EXCEPTION 'Bound platform capability cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'reserved_admin_capability';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF TG_TABLE_NAME = 'organizations' AND (
      EXISTS (SELECT 1 FROM public.oauth_clients WHERE organization_id = OLD.id AND deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.oauth_resources WHERE organization_id = OLD.id AND deleted_at IS NULL)
    ) OR TG_TABLE_NAME = 'oauth_clients' AND (
      EXISTS (SELECT 1 FROM public.entitlements WHERE client_id = to_jsonb(OLD)->>'client_id' AND deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.organization_capabilities WHERE client_id = to_jsonb(OLD)->>'client_id' AND deleted_at IS NULL)
    ) OR TG_TABLE_NAME = 'oauth_resources' AND (
      EXISTS (SELECT 1 FROM public.entitlements WHERE resource = to_jsonb(OLD)->>'identifier' AND deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.organization_capabilities WHERE resource = to_jsonb(OLD)->>'identifier' AND deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.oauth_client_resources WHERE resource_id = to_jsonb(OLD)->>'identifier' AND deleted_at IS NULL)
    ) THEN
      RAISE EXCEPTION 'Remove live product references before deletion' USING ERRCODE = '23503', CONSTRAINT = 'product_live_references';
    END IF;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    IF TG_TABLE_NAME IN ('users', 'organizations', 'groups', 'entitlements', 'organization_domains', 'organization_capabilities')
      AND to_jsonb(NEW)->>'status' <> 'disabled'
      OR TG_TABLE_NAME = 'members' AND to_jsonb(NEW)->>'status' <> 'revoked'
      OR TG_TABLE_NAME IN ('oauth_clients', 'oauth_resources') AND to_jsonb(NEW)->>'disabled' <> 'true'
      OR TG_TABLE_NAME = 'accounts' AND (to_jsonb(NEW)->>'access_token' IS NOT NULL OR to_jsonb(NEW)->>'refresh_token' IS NOT NULL OR to_jsonb(NEW)->>'id_token' IS NOT NULL OR to_jsonb(NEW)->>'password' IS NOT NULL)
      OR TG_TABLE_NAME = 'oauth_clients' AND to_jsonb(NEW)->>'client_secret' IS NOT NULL
      OR TG_TABLE_NAME = 'sso_providers' AND (to_jsonb(NEW)->>'oidc_config' IS NOT NULL OR to_jsonb(NEW)->>'saml_config' IS NOT NULL) THEN
      RAISE EXCEPTION 'Deleted product objects cannot confer authority or retain credentials' USING ERRCODE = '23514', CONSTRAINT = 'product_deletion_inactive';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION require_present_parent(parent_table regclass, parent_column name, parent_value text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE present boolean;
BEGIN
  IF parent_value IS NULL THEN RETURN; END IF;
  EXECUTE format('SELECT true FROM %s WHERE %I = $1::%s AND deleted_at IS NULL FOR SHARE', parent_table, parent_column, CASE WHEN parent_column = 'id' THEN 'uuid' ELSE 'text' END)
    INTO present USING parent_value;
  IF present IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Parent is unavailable' USING ERRCODE = '23503', CONSTRAINT = 'product_parent_unavailable';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_product_parents() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE row_data jsonb := to_jsonb(NEW);
BEGIN
  IF row_data->>'deleted_at' IS NOT NULL OR row_data->>'revoked' IS NOT NULL OR row_data->>'revoked_at' IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM public.require_present_parent('public.organizations', 'id', row_data->>'organization_id');
  IF TG_TABLE_NAME <> 'sso_providers' THEN
    PERFORM public.require_present_parent('public.users', 'id', row_data->>'user_id');
  END IF;
  PERFORM public.require_present_parent('public.users', 'id', row_data->>'inviter_id');
  PERFORM public.require_present_parent('public.members', 'id', row_data->>'member_id');
  PERFORM public.require_present_parent('public.groups', 'id', row_data->>'group_id');
  IF TG_TABLE_NAME <> 'oauth_clients' THEN
    PERFORM public.require_present_parent('public.oauth_clients', 'client_id', row_data->>'client_id');
  END IF;
  IF TG_TABLE_NAME <> 'oauth_resources' THEN
    PERFORM public.require_present_parent('public.oauth_resources', 'identifier', coalesce(row_data->>'resource', row_data->>'resource_id'));
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Validate fixed provenance independently of caller visibility; RLS still controls admission.
CREATE FUNCTION validate_grant_authentication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE evidence jsonb;
BEGIN
  IF NEW.authentication IS NULL THEN RETURN NEW; END IF;
  SELECT jsonb_build_object(
    'userId', s.user_id, 'memberId', m.id, 'authenticationSessionId', s.id,
    'authenticationAccountId', a.id, 'authenticationOrganizationId', p.organization_id,
    'authenticationProviderId', p.id, 'authenticationProviderRevision', p.revision,
    'brokerAuthenticatedAt', to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'upstreamAuthTime', CASE WHEN s.upstream_auth_time IS NULL THEN NULL ELSE to_char(s.upstream_auth_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'sessionExpiresAt', to_char(s.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) INTO evidence
  FROM public.sessions s
  JOIN public.accounts a ON a.id = s.authentication_account_id AND a.user_id = s.user_id AND a.deleted_at IS NULL
  JOIN public.sso_providers p ON p.id = s.authentication_provider_id AND p.revision = s.authentication_provider_revision
    AND p.organization_id = s.authentication_organization_id AND p.issuer = a.issuer AND p.provider_id = a.provider_id AND p.deleted_at IS NULL
  JOIN public.members m ON m.user_id = s.user_id AND m.organization_id = p.organization_id
  WHERE s.id = NEW.authentication_session_id AND s.user_id = NEW.user_id AND s.created_at = NEW.auth_time
    AND m.id = NEW.member_id AND m.organization_id = NEW.organization_id;
  IF evidence IS NULL OR evidence <> NEW.authentication THEN
    RAISE EXCEPTION 'Invalid grant authentication evidence' USING ERRCODE = '23514', CONSTRAINT = 'grant_authentication_provenance';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION record_user_oauth_subjects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE g public.grant_contexts; public_client text; source jsonb;
BEGIN
  IF NEW.schema_version <> 4 OR NEW.action NOT IN (
    'oauth.user.authorized', 'oauth.user.denied', 'oauth.user.issued', 'oauth.user.replayed', 'oauth.user.revoked'
  ) THEN RETURN NEW; END IF;
  SELECT * INTO g FROM public.grant_contexts WHERE id = public.try_uuid(NEW.target_id);
  SELECT client_id INTO public_client FROM public.oauth_clients WHERE id = g.client_instance_id;
  IF g.id IS NULL OR NEW.target_type <> 'grant_context' OR NEW.organization_id IS DISTINCT FROM g.organization_id
    OR NOT ((NEW.actor_type = 'user' AND NEW.actor_id = g.user_id::text) OR (NEW.actor_type = 'client' AND NEW.actor_id = public_client))
    OR NEW.data->'authentication' IS DISTINCT FROM g.authentication OR g.authentication IS NULL THEN
    RAISE EXCEPTION 'Invalid user OAuth outcome' USING ERRCODE = '23514', CONSTRAINT = 'user_oauth_audit_provenance';
  END IF;
  INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
  SELECT NEW.id, subject.kind, subject.id, subject.relationship, g.organization_id, 'recorded'
  FROM (VALUES
    ('user', g.user_id::text, 'affected'), ('member', g.member_id::text, 'authorized'),
    ('organization', g.organization_id::text, 'authorized'), ('client', g.client_instance_id::text, 'authorized'),
    ('resource', g.resource_instance_id::text, 'authorized'),
    ('session', g.authentication_session_id::text, 'authenticated'),
    ('account', g.authentication->>'authenticationAccountId', 'authenticated'),
    ('sso_provider', g.authentication->>'authenticationProviderId', 'authenticated')
  ) AS subject(kind, id, relationship) WHERE subject.id IS NOT NULL;
  FOR source IN SELECT value FROM jsonb_array_elements(coalesce(NEW.data->'decision'->'evidence'->'capabilities', '[]'::jsonb)) LOOP
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (NEW.id, 'capability', (source->>'id')::uuid::text, 'authorized', g.organization_id, 'recorded') ON CONFLICT DO NOTHING;
  END LOOP;
  FOR source IN SELECT value FROM jsonb_array_elements(coalesce(NEW.data->'decision'->'evidence'->'assignments', '[]'::jsonb)) LOOP
    INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
    VALUES (NEW.id, 'entitlement', (source->>'id')::uuid::text, 'authorized', g.organization_id, 'recorded') ON CONFLICT DO NOTHING;
    IF source->>'groupId' IS NOT NULL THEN
      INSERT INTO public.audit_event_subjects (event_id, entity_type, entity_id, relationship, organization_id, provenance)
      VALUES (NEW.id, 'group', (source->>'groupId')::uuid::text, 'authorized', g.organization_id, 'recorded'),
        (NEW.id, 'group_member', (source->'groupMembership'->>'id')::uuid::text, 'authorized', g.organization_id, 'recorded') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_clients_identity_guard BEFORE UPDATE ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION protect_oauth_client_identity();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_identity_guard BEFORE UPDATE ON oauth_resources
FOR EACH ROW EXECUTE FUNCTION protect_oauth_resource_identity();
--> statement-breakpoint
CREATE TRIGGER oauth_clients_reserve_identity AFTER INSERT ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION reserve_security_identifier();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_reserve_identity AFTER INSERT ON oauth_resources
FOR EACH ROW EXECUTE FUNCTION reserve_security_identifier();
--> statement-breakpoint
CREATE TRIGGER security_identifiers_immutable BEFORE UPDATE OR DELETE ON security_identifiers
FOR EACH ROW EXECUTE FUNCTION protect_security_identifier();
--> statement-breakpoint
CREATE TRIGGER system_bindings_immutable BEFORE UPDATE OR DELETE ON system_bindings
FOR EACH ROW EXECUTE FUNCTION protect_system_binding();
--> statement-breakpoint
CREATE TRIGGER audit_events_capture_subjects AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION record_audit_subjects();
--> statement-breakpoint
CREATE TRIGGER admin_operations_immutable BEFORE UPDATE OR DELETE ON admin_operations
FOR EACH ROW EXECUTE FUNCTION protect_admin_operation();
--> statement-breakpoint
CREATE TRIGGER oauth_clients_revision_guard BEFORE UPDATE ON oauth_clients
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER oauth_client_resources_revision AFTER INSERT OR UPDATE OR DELETE ON oauth_client_resources
FOR EACH ROW EXECUTE FUNCTION touch_client_resource_revision();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_revision_guard BEFORE UPDATE ON oauth_resources
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER members_identity_guard BEFORE UPDATE ON members
FOR EACH ROW EXECUTE FUNCTION protect_member_identity();
--> statement-breakpoint
CREATE TRIGGER organizations_authorization_version_guard BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION protect_organization_authorization_version();
--> statement-breakpoint
CREATE TRIGGER members_revision_guard BEFORE UPDATE ON members
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER organizations_revision_guard BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER sso_providers_revision_guard BEFORE UPDATE ON sso_providers
FOR EACH ROW EXECUTE FUNCTION protect_sso_provider_revision();
--> statement-breakpoint
CREATE TRIGGER groups_revision_guard BEFORE UPDATE ON groups
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER group_members_identity_guard BEFORE UPDATE ON group_members
FOR EACH ROW EXECUTE FUNCTION protect_group_assignment_identity();
--> statement-breakpoint
CREATE TRIGGER group_members_revision_guard BEFORE UPDATE ON group_members
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER entitlements_revision_guard BEFORE UPDATE ON entitlements
FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER resource_ownership_immutable BEFORE UPDATE ON oauth_resources FOR EACH ROW EXECUTE FUNCTION protect_resource_ownership();
--> statement-breakpoint
CREATE TRIGGER private_resource_assignment BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION protect_private_resource_assignment();
--> statement-breakpoint
CREATE TRIGGER capability_target_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_capability_target();
--> statement-breakpoint
CREATE TRIGGER capability_private_resource_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_private_resource_assignment();
--> statement-breakpoint
CREATE TRIGGER capability_revision_guard BEFORE UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_configuration_revision();
--> statement-breakpoint
CREATE TRIGGER reserved_admin_capability_guard BEFORE DELETE ON organization_capabilities
FOR EACH ROW EXECUTE FUNCTION protect_reserved_admin_capability();
--> statement-breakpoint
CREATE TRIGGER grant_context_guard BEFORE INSERT OR UPDATE ON grant_contexts
FOR EACH ROW EXECUTE FUNCTION protect_grant_context();
--> statement-breakpoint
CREATE TRIGGER sessions_authentication_origin_guard BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION protect_session_authentication_origin();
--> statement-breakpoint
CREATE TRIGGER users_deletion_guard BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER organizations_deletion_guard BEFORE INSERT OR UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER accounts_deletion_guard BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER members_deletion_guard BEFORE INSERT OR UPDATE ON members FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER invitations_deletion_guard BEFORE INSERT OR UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER organization_domains_deletion_guard BEFORE INSERT OR UPDATE ON organization_domains FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER groups_deletion_guard BEFORE INSERT OR UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER group_members_deletion_guard BEFORE INSERT OR UPDATE ON group_members FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER entitlements_deletion_guard BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_clients_deletion_guard BEFORE INSERT OR UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_resources_deletion_guard BEFORE INSERT OR UPDATE ON oauth_resources FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_client_resources_deletion_guard BEFORE INSERT OR UPDATE ON oauth_client_resources FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER oauth_consents_deletion_guard BEFORE INSERT OR UPDATE ON oauth_consents FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER sso_providers_deletion_guard BEFORE INSERT OR UPDATE ON sso_providers FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER organization_capabilities_deletion_guard BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_product_deletion();
--> statement-breakpoint
CREATE TRIGGER zz_accounts_present_parents BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_members_present_parents BEFORE INSERT OR UPDATE ON members FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_invitations_present_parents BEFORE INSERT OR UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_organization_domains_present_parents BEFORE INSERT OR UPDATE ON organization_domains FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_groups_present_parents BEFORE INSERT OR UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_group_members_present_parents BEFORE INSERT OR UPDATE ON group_members FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_entitlements_present_parents BEFORE INSERT OR UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_clients_present_parents BEFORE INSERT OR UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_resources_present_parents BEFORE INSERT OR UPDATE ON oauth_resources FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_client_resources_present_parents BEFORE INSERT OR UPDATE ON oauth_client_resources FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_consents_present_parents BEFORE INSERT OR UPDATE ON oauth_consents FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_sso_providers_present_parents BEFORE INSERT OR UPDATE ON sso_providers FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_organization_capabilities_present_parents BEFORE INSERT OR UPDATE ON organization_capabilities FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_sessions_present_parents BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_access_tokens_present_parents BEFORE INSERT OR UPDATE ON oauth_access_tokens FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER zz_oauth_refresh_tokens_present_parents BEFORE INSERT OR UPDATE ON oauth_refresh_tokens FOR EACH ROW EXECUTE FUNCTION protect_product_parents();
--> statement-breakpoint
CREATE TRIGGER grant_authentication_provenance BEFORE INSERT ON grant_contexts
FOR EACH ROW EXECUTE FUNCTION validate_grant_authentication();
--> statement-breakpoint
CREATE TRIGGER audit_events_user_oauth_subjects AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION record_user_oauth_subjects();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION protect_grant_context(), capture_audit_subjects(audit_events, text), record_audit_subjects(), reserve_security_identifier(), public.purge_operation_results(uuid, integer), record_user_oauth_subjects(), validate_grant_authentication() FROM PUBLIC;

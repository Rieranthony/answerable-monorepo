-- Prepared mutations: one row per intent, moved from status to status by compare-and-set. The commit token is kept only as its SHA-256.

create table intents (
  intent_id uuid primary key,
  organisation_id uuid not null,
  user_id text not null,
  membership_id text not null,
  client_id text not null,
  capability_identity text not null,
  capability_version text not null,
  input jsonb not null,
  targets jsonb not null,
  preview jsonb not null,
  plan jsonb,
  policy_class text not null check (policy_class in ('agent', 'controlled', 'human')),
  approval jsonb not null,
  commit_token_hash text not null,
  status text not null check (status in ('prepared', 'awaiting_approval', 'committing', 'committed', 'failed', 'expired', 'stale')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  receipt jsonb,
  check ((status = 'committed') = (receipt is not null))
);

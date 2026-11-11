-- Application role. Migrations run as the owner; the API connects as jobagent_app,
-- which is subject to row-level security on every candidate-owned table.
do $$ begin
  if not exists (select from pg_roles where rolname = 'jobagent_app') then
    create role jobagent_app login;
  end if;
end $$;

create or replace function app_user_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---------- identity (no RLS: read before the user is known; never exposed by id) ----------
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ---------- shared job catalogue (not user-owned; fetched once for all users) ----------
create table boards (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('greenhouse', 'lever', 'ashby')),
  token text not null,
  company_name text not null default '',
  last_synced_at timestamptz,
  last_error text,
  unique (kind, token)
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards on delete cascade,
  external_id text not null,
  company text not null,
  title text not null,
  location text not null default '',
  remote boolean not null default false,
  url text not null,
  apply_url text not null,
  description text not null default '',
  content_hash text not null,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (board_id, external_id)
);
create index jobs_board_open on jobs (board_id) where closed_at is null;

-- ---------- candidate-owned data (RLS) ----------
create table candidate_profiles (
  user_id uuid primary key references users on delete cascade,
  full_name text not null default '',
  email text not null default '',
  phone text not null default '',
  linkedin_url text not null default '',
  headline text not null default '',
  location text not null default '',
  work_authorization text not null default '',
  years_experience int,
  skills text[] not null default '{}',
  languages text[] not null default '{}',
  summary text not null default '',
  updated_at timestamptz not null default now()
);

create table job_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  name text not null default 'Default',
  titles text[] not null default '{}',
  keywords text[] not null default '{}',
  locations text[] not null default '{}',
  remote_ok boolean not null default true,
  salary_floor int,
  excluded_companies text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  min_score int not null default 40,
  unique (user_id, name)
);

create table user_settings (
  user_id uuid primary key references users on delete cascade,
  ai_provider text not null default 'none' check (ai_provider in ('none', 'ollama', 'openai', 'anthropic')),
  ai_model text not null default '',
  monthly_budget_usd numeric(10, 2) not null default 5,
  resume_builder_url text not null default ''
);

create table job_sources (
  user_id uuid not null references users on delete cascade,
  board_id uuid not null references boards on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, board_id)
);

create table job_matches (
  user_id uuid not null references users on delete cascade,
  job_id uuid not null references jobs on delete cascade,
  score int not null,
  filtered boolean not null default false,
  reasons jsonb not null default '[]',
  unknowns jsonb not null default '[]',
  status text not null default 'new' check (status in ('new', 'saved', 'dismissed')),
  ai_score int,
  ai_assessment jsonb,
  ai_content_hash text,
  computed_at timestamptz not null default now(),
  primary key (user_id, job_id)
);
create index job_matches_rank on job_matches (user_id, score desc) where not filtered;

-- Resumes are immutable snapshots: the app role may insert and delete, never update.
-- A new upload of an edited file (from the external Resume Builder) becomes a new row.
create table resume_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  filename text not null,
  mime_type text not null,
  size_bytes int not null,
  sha256 text not null,
  content bytea not null,
  extracted_text text not null default '',
  uploaded_at timestamptz not null default now(),
  unique (user_id, sha256)
);

create table application_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  job_id uuid not null references jobs,
  resume_id uuid references resume_files,
  cover_letter text not null default '',
  cover_letter_source text not null default 'template',
  answers jsonb not null default '[]',
  notes text not null default '',
  status text not null default 'awaiting_review' check (status in
    ('awaiting_review', 'approved', 'handed_off', 'submitted', 'rejected', 'manual_action_required')),
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, job_id)
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  draft_id uuid not null references application_drafts on delete cascade,
  content_hash text not null,
  approved_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index approvals_draft on approvals (draft_id);

create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  job_id uuid not null references jobs,
  draft_id uuid not null references application_drafts,
  approval_id uuid not null references approvals,
  idempotency_key text not null,
  snapshot jsonb not null,
  submitted_at timestamptz not null default now(),
  unique (user_id, job_id),
  unique (user_id, idempotency_key)
);

create table audit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references users on delete cascade,
  type text not null,
  entity_id text,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create index audit_user_at on audit_events (user_id, at desc);

create table ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references users on delete cascade,
  provider text not null,
  model text not null,
  task text not null,
  prompt_version text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  est_cost_usd numeric(12, 6) not null default 0,
  at timestamptz not null default now()
);
create index ai_usage_user_at on ai_usage (user_id, at);

do $$
declare t text;
begin
  foreach t in array array['candidate_profiles', 'job_preferences', 'user_settings', 'job_sources', 'resume_files',
    'job_matches', 'application_drafts', 'approvals', 'applications', 'audit_events', 'ai_usage']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (user_id = app_user_id()) with check (user_id = app_user_id())', t);
  end loop;
end $$;

grant usage on schema public to jobagent_app;
grant select, insert, update, delete on all tables in schema public to jobagent_app;
-- Audit trail and AI usage are append-only; approvals and applications cannot be deleted.
revoke update, delete on audit_events, ai_usage from jobagent_app;
revoke delete on approvals, applications from jobagent_app;
revoke update on applications from jobagent_app;
revoke update on resume_files from jobagent_app;

-- Cross-tenant reads needed by the background scheduler, exposed only as narrow functions.
create function boards_due(max_age interval, max_rows int) returns setof boards
language sql security definer set search_path = public as $$
  select b.* from boards b
  where exists (select from job_sources s where s.board_id = b.id and s.enabled)
    and (b.last_synced_at is null or b.last_synced_at < now() - max_age)
  order by b.last_synced_at nulls first
  limit max_rows
$$;

create function board_subscribers(b uuid) returns setof uuid
language sql security definer set search_path = public as $$
  select user_id from job_sources where board_id = b and enabled
$$;

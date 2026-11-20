create table gmail_oauth_attempts (
  state_hash text primary key,
  user_id uuid not null references users on delete cascade,
  verifier text not null,
  expires_at timestamptz not null
);
create index gmail_oauth_attempts_user on gmail_oauth_attempts (user_id);

create table gmail_connections (
  user_id uuid primary key references users on delete cascade,
  email text not null,
  encrypted_refresh_token text not null,
  connected_at timestamptz not null default now()
);

alter table gmail_oauth_attempts enable row level security;
alter table gmail_connections enable row level security;
create policy tenant_isolation on gmail_oauth_attempts
  using (user_id = app_user_id()) with check (user_id = app_user_id());
create policy tenant_isolation on gmail_connections
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, delete on gmail_oauth_attempts to jobagent_app;
grant select, insert, delete on gmail_connections to jobagent_app;

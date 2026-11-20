create table gmail_alert_jobs (
  user_id uuid not null references users on delete cascade,
  external_id text not null,
  title text,
  received_at timestamptz not null,
  primary key (user_id, external_id)
);

alter table gmail_alert_jobs enable row level security;
create policy tenant_isolation on gmail_alert_jobs
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update on gmail_alert_jobs to jobagent_app;

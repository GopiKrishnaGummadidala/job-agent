create table gmail_processed_job_alerts (
  user_id uuid not null references users on delete cascade,
  mailbox text not null,
  provider text not null check (provider in ('linkedin', 'indeed', 'glassdoor')),
  message_id text not null,
  processed_at timestamptz not null default now(),
  primary key (user_id, mailbox, provider, message_id)
);
alter table gmail_processed_job_alerts enable row level security;
create policy gmail_processed_alerts_owner on gmail_processed_job_alerts
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert on gmail_processed_job_alerts to jobagent_app;

alter table gmail_oauth_attempts add column purpose text not null default 'gmail'
  check (purpose in ('gmail', 'calendar'));

create table private_calendar_connections (
  user_id uuid primary key references users on delete cascade,
  encrypted_refresh_token text not null
);
create table private_calendar_interviews (
  user_id uuid not null references users on delete cascade,
  event_id text not null,
  title text not null,
  starts_at timestamptz not null,
  calendar_url text,
  meeting_url text,
  company text not null,
  job_title text not null,
  primary key (user_id, event_id)
);
alter table private_calendar_connections enable row level security;
alter table private_calendar_interviews enable row level security;
create policy calendar_connection_owner on private_calendar_connections
  using (user_id = app_user_id()) with check (user_id = app_user_id());
create policy calendar_interview_owner on private_calendar_interviews
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update, delete on private_calendar_connections to jobagent_app;
grant select, insert, update, delete on private_calendar_interviews to jobagent_app;

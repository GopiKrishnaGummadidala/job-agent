create table gmail_discovery_windows (
  user_id uuid not null references users on delete cascade,
  mailbox text not null,
  provider text not null check (provider in ('linkedin', 'indeed', 'glassdoor', 'stepstone')),
  scanned_through timestamptz not null,
  primary key (user_id, mailbox, provider)
);
alter table gmail_discovery_windows enable row level security;
create policy gmail_discovery_windows_owner on gmail_discovery_windows
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update (scanned_through) on gmail_discovery_windows to jobagent_app;

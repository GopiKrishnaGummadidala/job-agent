create table private_interviews (
  user_id uuid not null references users on delete cascade,
  message_id text not null,
  subject text not null,
  sender text not null,
  received_at timestamptz not null,
  company text not null default '',
  job_title text not null default '',
  stage text not null default 'unknown' check (stage in ('unknown', 'screen', 'first', 'second', 'final')),
  outcome text not null default 'review' check (outcome in ('review', 'positive', 'scheduled', 'rejected', 'offer', 'unrelated')),
  primary key (user_id, message_id)
);

alter table private_interviews enable row level security;
create policy private_interviews_owner on private_interviews
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update (company, job_title, stage, outcome) on private_interviews to jobagent_app;

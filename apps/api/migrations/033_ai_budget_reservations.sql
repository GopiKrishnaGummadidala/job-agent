alter table user_settings add column daily_budget_usd numeric(10,2) not null default 1
  check (daily_budget_usd >= 0 and daily_budget_usd <= 1000);
create table ai_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  estimated_usd numeric not null check (estimated_usd > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);
create index ai_budget_reservations_owner on ai_budget_reservations (user_id, expires_at);
alter table ai_budget_reservations enable row level security;
create policy ai_budget_reservations_owner on ai_budget_reservations
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, delete on ai_budget_reservations to jobagent_app;

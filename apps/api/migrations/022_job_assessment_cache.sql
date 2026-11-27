create table job_assessment_cache (
  user_id uuid not null,
  job_id uuid not null,
  cache_key text not null,
  assessment jsonb not null,
  assessed_at timestamptz not null default now(),
  primary key (user_id, job_id, cache_key),
  foreign key (user_id, job_id) references job_matches (user_id, job_id) on delete cascade
);
alter table job_assessment_cache enable row level security;
create policy job_assessment_cache_owner on job_assessment_cache
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert on job_assessment_cache to jobagent_app;

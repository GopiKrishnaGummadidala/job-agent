alter table job_preferences
  add column salary_target_eur integer check (salary_target_eur between 0 and 10000000),
  add column target_languages text[] not null default '{}',
  add column target_engagements text[] not null default '{}';

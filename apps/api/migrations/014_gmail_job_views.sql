create table gmail_job_views (
  user_id uuid not null,
  provider text not null,
  external_id text not null,
  viewer_id uuid not null references users on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (user_id, provider, external_id, viewer_id),
  foreign key (user_id, provider, external_id)
    references gmail_alert_jobs (user_id, provider, external_id) on delete cascade
);

insert into gmail_job_views (user_id, provider, external_id, viewer_id, viewed_at)
select user_id, provider, external_id, status_actor_id, status_at
from gmail_alert_jobs
where status = 'viewed' and status_actor_id is not null and status_at is not null;

alter table gmail_job_views enable row level security;
create policy gmail_job_views_workspace on gmail_job_views using (
  exists (
    select 1 from gmail_alert_jobs j
    where j.user_id = gmail_job_views.user_id
      and j.provider = gmail_job_views.provider
      and j.external_id = gmail_job_views.external_id
  )
) with check (
  viewer_id = app_user_id() and exists (
    select 1 from gmail_alert_jobs j
    where j.user_id = gmail_job_views.user_id
      and j.provider = gmail_job_views.provider
      and j.external_id = gmail_job_views.external_id
  )
);
grant select, insert, update (viewed_at) on gmail_job_views to jobagent_app;

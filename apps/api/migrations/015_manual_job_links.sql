alter table gmail_alert_jobs drop constraint gmail_alert_jobs_provider_check;
alter table gmail_alert_jobs add column manual_url text;
alter table gmail_alert_jobs add constraint gmail_alert_jobs_provider_check check (
  (provider = 'manual' and manual_url is not null)
  or (provider in ('linkedin', 'indeed', 'glassdoor') and manual_url is null)
);
create unique index gmail_manual_job_url on gmail_alert_jobs (user_id, manual_url)
where provider = 'manual';

drop policy gmail_jobs_insert on gmail_alert_jobs;
create policy gmail_jobs_insert on gmail_alert_jobs for insert with check (
  user_id = app_user_id() or (provider = 'manual' and exists (
    select 1 from workspace_delegates d
    where d.owner_id = user_id and d.delegate_id = app_user_id()
  ))
);

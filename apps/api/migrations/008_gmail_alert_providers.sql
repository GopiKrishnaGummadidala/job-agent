alter table gmail_alert_jobs add column provider text not null default 'linkedin'
  check (provider in ('linkedin', 'indeed', 'glassdoor'));
alter table gmail_alert_jobs drop constraint gmail_alert_jobs_pkey;
alter table gmail_alert_jobs add primary key (user_id, provider, external_id);

alter table gmail_alert_jobs drop constraint gmail_alert_jobs_provider_check;
alter table gmail_alert_jobs add constraint gmail_alert_jobs_provider_check check (
  (provider = 'manual' and manual_url is not null)
  or (provider in ('linkedin', 'indeed', 'glassdoor', 'stepstone') and manual_url is null)
);
alter table gmail_processed_job_alerts drop constraint gmail_processed_job_alerts_provider_check;
alter table gmail_processed_job_alerts add constraint gmail_processed_job_alerts_provider_check
  check (provider in ('linkedin', 'indeed', 'glassdoor', 'stepstone'));

alter table gmail_alert_jobs drop constraint gmail_alert_jobs_status_check;
alter table gmail_alert_jobs add constraint gmail_alert_jobs_status_check
  check (status in ('pending', 'viewed', 'applied', 'interviewed', 'unfit'));

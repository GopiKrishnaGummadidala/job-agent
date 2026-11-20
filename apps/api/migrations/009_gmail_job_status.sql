alter table gmail_alert_jobs add column status text not null default 'pending'
  check (status in ('pending', 'viewed', 'applied'));

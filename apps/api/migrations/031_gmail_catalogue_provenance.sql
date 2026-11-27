create function gmail_public_posting_url(provider text, external_id text, source_url text) returns text
language sql immutable parallel safe as $$
  select coalesce(source_url, case
    when provider = 'linkedin' and external_id ~ '^[0-9]+$'
      then 'https://www.linkedin.com/jobs/view/' || external_id || '/'
    when provider = 'indeed' and external_id ~ '^[a-f0-9]{16}$'
      then 'https://www.indeed.com/viewjob?jk=' || external_id
    when provider = 'glassdoor' and external_id ~ '^[0-9]+$'
      then 'https://www.glassdoor.com/partner/jobListing.htm?jobListingId=' || external_id
  end)
$$;
create index gmail_catalogue_posting_url on gmail_alert_jobs
  (user_id, md5(normalized_posting_url(gmail_public_posting_url(provider, external_id, source_url))))
  where provider <> 'manual';

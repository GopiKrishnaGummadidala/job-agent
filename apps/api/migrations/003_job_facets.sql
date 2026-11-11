-- Search facets for Job Explorer filters.
alter table jobs
  add column employment_type text not null default 'full_time'
    check (employment_type in ('full_time', 'part_time', 'contract', 'temporary', 'internship', 'working_student')),
  add column workplace text not null default 'onsite'
    check (workplace in ('remote', 'hybrid', 'onsite')),
  add column seniority text not null default 'mid'
    check (seniority in ('intern', 'junior', 'mid', 'senior', 'staff', 'lead'));

update jobs set workplace = 'remote' where remote;

create index jobs_posted on jobs ((coalesce(posted_at, first_seen_at)));

-- Re-fetch every board on the next refresh so the new fields are filled from the boards' data.
update boards set last_synced_at = null;

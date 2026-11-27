alter table job_source_references add column duplicate_key text;
create function posting_duplicate_key(address text, company text, title text, location text, description text)
returns text language sql immutable strict parallel safe as $$
  select case when btrim(company) <> '' and btrim(title) <> '' and btrim(location) <> '' and btrim(description) <> ''
    and address ~ '^https?://[^/]+/(.+|\?[^#]+)$'
    then jsonb_build_array(address,
      lower(regexp_replace(btrim(company), '[[:space:]]+', ' ', 'g')),
      lower(regexp_replace(btrim(title), '[[:space:]]+', ' ', 'g')),
      lower(regexp_replace(btrim(location), '[[:space:]]+', ' ', 'g')),
      md5(lower(regexp_replace(btrim(description), '[[:space:]]+', ' ', 'g')))
    )::text end
$$;
update job_source_references r
set duplicate_key = posting_duplicate_key(r.normalized_url, j.company, j.title, j.location, j.description)
from jobs j where j.id = r.job_id;
create index job_source_references_duplicate_key
  on job_source_references (md5(duplicate_key)) where duplicate_key is not null;

create or replace function sync_job_source_reference() returns trigger language plpgsql as $$
declare
  normalized text := normalized_posting_url(coalesce(nullif(new.apply_url, ''), new.url));
begin
  insert into job_source_references (
    board_id, external_id, job_id, source_url, normalized_url, source_content_hash, first_seen_at, last_seen_at, duplicate_key
  ) values (
    new.board_id, new.external_id, new.id, new.url, normalized, new.content_hash, new.first_seen_at, new.last_seen_at,
    posting_duplicate_key(normalized, new.company, new.title, new.location, new.description)
  ) on conflict (board_id, external_id) do update set
    source_url = excluded.source_url, normalized_url = excluded.normalized_url,
    source_content_hash = excluded.source_content_hash, last_seen_at = excluded.last_seen_at,
    duplicate_key = excluded.duplicate_key;
  return new;
end
$$;
drop trigger jobs_sync_source_reference on jobs;
create trigger jobs_sync_source_reference
after insert or update of url, apply_url, content_hash, last_seen_at, company, title, location, description on jobs
for each row execute function sync_job_source_reference();

create table job_duplicate_links (
  user_id uuid not null,
  job_id uuid not null,
  canonical_job_id uuid not null,
  primary key (user_id, job_id),
  foreign key (user_id, job_id) references job_matches (user_id, job_id) on delete cascade,
  foreign key (user_id, canonical_job_id) references job_matches (user_id, job_id) on delete cascade,
  check (job_id <> canonical_job_id)
);
create index job_duplicate_links_canonical on job_duplicate_links (user_id, canonical_job_id);
alter table job_duplicate_links enable row level security;
create policy job_duplicate_links_owner on job_duplicate_links
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, delete on job_duplicate_links to jobagent_app;

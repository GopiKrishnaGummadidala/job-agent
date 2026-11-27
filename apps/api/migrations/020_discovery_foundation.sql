alter table jobs
  add column company_website text,
  add column required_skills text[],
  add column preferred_skills text[],
  add column required_languages text[],
  add column salary_min numeric,
  add column salary_max numeric,
  add column salary_currency text,
  add column salary_period text;

-- Keep the identity parameters and their order. Only remove known tracking keys.
create function normalized_posting_url(url text) returns text
language sql immutable strict parallel safe as $$
  with parts as (
    select regexp_match(btrim(url), '^(https?://[^/?#]+)([^?#]*)(\?([^#]*))?(#.*)?$', 'i') as m
  ), cleaned as (
    select lower(m[1]) || coalesce(nullif(m[2], ''), '/') as base, m[5] as fragment,
           (select string_agg(pair, '&' order by pos)
            from unnest(string_to_array(m[4], '&')) with ordinality as args(pair, pos)
            where lower(split_part(pair, '=', 1)) !~ '^(utm_[a-z0-9_]+|gclid|fbclid|msclkid)$'
              and pair <> '') as query
    from parts
  )
  select base || coalesce('?' || query, '') || coalesce(fragment, '') from cleaned
$$;

create table job_source_references (
  board_id uuid not null references boards on delete cascade,
  external_id text not null,
  job_id uuid not null references jobs on delete cascade,
  source_url text not null,
  normalized_url text,
  source_content_hash text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (board_id, external_id)
);
create index job_source_references_job on job_source_references (job_id);
create index job_source_references_url on job_source_references (normalized_url) where normalized_url is not null;
grant select, insert, update on job_source_references to jobagent_app;

insert into job_source_references (
  board_id, external_id, job_id, source_url, normalized_url, source_content_hash, first_seen_at, last_seen_at
)
select board_id, external_id, id, url, normalized_posting_url(coalesce(nullif(apply_url, ''), url)),
       content_hash, first_seen_at, last_seen_at
from jobs;

create function sync_job_source_reference() returns trigger language plpgsql as $$
begin
  insert into job_source_references (
    board_id, external_id, job_id, source_url, normalized_url, source_content_hash, first_seen_at, last_seen_at
  ) values (
    new.board_id, new.external_id, new.id, new.url, normalized_posting_url(coalesce(nullif(new.apply_url, ''), new.url)),
    new.content_hash, new.first_seen_at, new.last_seen_at
  ) on conflict (board_id, external_id) do update set
    source_url = excluded.source_url, normalized_url = excluded.normalized_url,
    source_content_hash = excluded.source_content_hash, last_seen_at = excluded.last_seen_at;
  return new;
end
$$;

create trigger jobs_sync_source_reference
after insert or update of url, apply_url, content_hash, last_seen_at on jobs
for each row execute function sync_job_source_reference();

create table job_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards on delete cascade,
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  jobs_discovered integer not null default 0,
  jobs_inserted integer not null default 0,
  jobs_updated integer not null default 0,
  duplicates_prevented integer not null default 0,
  failed_records integer not null default 0,
  error_details text
);
create unique index job_discovery_runs_active on job_discovery_runs (board_id) where status = 'running';
create index job_discovery_runs_board_started on job_discovery_runs (board_id, started_at desc);
grant select, insert, update on job_discovery_runs to jobagent_app;

create table board_refresh_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  board_id uuid not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  attempts integer not null default 0,
  error_details text,
  foreign key (user_id, board_id) references job_sources (user_id, board_id) on delete cascade
);
create unique index board_refresh_one_active_request on board_refresh_requests (user_id, board_id)
  where status in ('queued', 'running');
create index board_refresh_requests_due on board_refresh_requests (available_at, requested_at)
  where status = 'queued';
alter table board_refresh_requests enable row level security;
create policy board_refresh_requests_owner on board_refresh_requests
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, update (status, ended_at) on board_refresh_requests to jobagent_app;

create function claim_board_refresh() returns table(id uuid, board_id uuid, attempts integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update board_refresh_requests r
  set status = case when r.attempts >= 3 then 'failed' else 'queued' end,
      ended_at = case when r.attempts >= 3 then now() end,
      error_details = 'The refresh was interrupted.'
  where r.status = 'running' and r.started_at < now() - interval '35 minutes';
  return query
  with next_request as (
    select r.id from board_refresh_requests r join job_sources s using (user_id, board_id)
    where r.status = 'queued' and r.available_at <= now() and s.enabled
      and not exists (select 1 from job_discovery_runs d where d.board_id = r.board_id
        and d.status = 'running' and d.started_at >= now() - interval '30 minutes')
    order by r.available_at, r.requested_at, r.id
    limit 1 for update of r skip locked
  )
  update board_refresh_requests r set status = 'running', started_at = now(), attempts = r.attempts + 1
  from next_request n where r.id = n.id returning r.id, r.board_id, r.attempts;
end
$$;

create function finish_board_refresh(request_id uuid, attempt integer, succeeded boolean) returns void
language sql security definer set search_path = pg_catalog, public as $$
  update board_refresh_requests r
  set status = case when succeeded then 'completed' when r.attempts >= 3 then 'failed' else 'queued' end,
      available_at = now() + (interval '30 seconds' * power(2, r.attempts - 1)),
      ended_at = case when succeeded or r.attempts >= 3 then now() end,
      error_details = case when not succeeded then 'Board refresh failed. Check the board or try again.' end
  where r.id = request_id and r.attempts = attempt and r.status = 'running'
$$;
revoke all on function claim_board_refresh(), finish_board_refresh(uuid, integer, boolean) from public;
grant execute on function claim_board_refresh(), finish_board_refresh(uuid, integer, boolean) to jobagent_app;

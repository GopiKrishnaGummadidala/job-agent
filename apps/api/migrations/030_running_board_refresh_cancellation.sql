alter table board_refresh_requests add column postings_saved_at timestamptz;
alter table job_discovery_runs drop constraint job_discovery_runs_status_check;
alter table job_discovery_runs add constraint job_discovery_runs_status_check
  check (status in ('running', 'completed', 'failed', 'cancelled'));

-- Called within the same SQL statement as the posting writes.
create function reserve_board_refresh_save(request_id uuid, attempt integer, target_board uuid) returns boolean
language sql volatile security definer set search_path = pg_catalog, public as $$
  with allowed as (
    update board_refresh_requests r set postings_saved_at = coalesce(r.postings_saved_at, now())
    where r.id = request_id and r.board_id = target_board and r.attempts = attempt and r.status = 'running'
    returning r.id
  )
  select exists(select 1 from allowed)
$$;
revoke all on function reserve_board_refresh_save(uuid, integer, uuid) from public;
grant execute on function reserve_board_refresh_save(uuid, integer, uuid) to jobagent_app;

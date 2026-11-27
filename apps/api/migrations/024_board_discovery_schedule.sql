alter table job_sources
  add column schedule_times time[] not null default array['08:00', '13:00', '18:00']::time[],
  add column scheduled_through timestamptz;

create function latest_discovery_slot(schedule time[], as_of timestamptz) returns timestamptz
language sql stable parallel safe as $$
  select max(slot) from (
    select (((as_of at time zone 'Europe/Berlin')::date - day_offset) + start_time)
      at time zone 'Europe/Berlin' as slot
    from generate_series(0, 1) as days(day_offset), unnest(schedule) as times(start_time)
  ) slots where slot <= as_of
$$;

create function scheduled_boards_due(max_rows integer) returns table(board_id uuid)
language sql security definer set search_path = pg_catalog, public as $$
  select b.id
  from boards b join job_sources s on s.board_id = b.id
  where s.enabled and latest_discovery_slot(s.schedule_times, now()) > coalesce(s.scheduled_through, s.created_at)
    and (b.last_error is null or b.last_synced_at < now() - interval '5 minutes')
    and not exists (select 1 from job_discovery_runs r where r.board_id = b.id and r.status = 'running'
                    and r.started_at > now() - interval '30 minutes')
  group by b.id
  order by min(latest_discovery_slot(s.schedule_times, now())), b.id
  limit greatest(0, least(max_rows, 50))
$$;

create function acknowledge_board_schedule(target_board uuid, processed_through timestamptz) returns void
language sql security definer set search_path = pg_catalog, public as $$
  update job_sources s
  set scheduled_through = latest_discovery_slot(s.schedule_times, least(processed_through, now()))
  from boards b
  where s.board_id = target_board and s.enabled and b.id = s.board_id
    and b.last_error is null
    and b.last_synced_at >= latest_discovery_slot(s.schedule_times, least(processed_through, now()))
    and latest_discovery_slot(s.schedule_times, least(processed_through, now())) > coalesce(s.scheduled_through, s.created_at)
$$;

revoke all on function scheduled_boards_due(integer) from public;
revoke all on function acknowledge_board_schedule(uuid, timestamptz) from public;
grant execute on function scheduled_boards_due(integer), acknowledge_board_schedule(uuid, timestamptz) to jobagent_app;

create table workspace_invites (
  owner_id uuid not null references users on delete cascade,
  delegate_email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  primary key (owner_id, delegate_email)
);

create table workspace_delegates (
  owner_id uuid not null references users on delete cascade,
  delegate_id uuid not null references users on delete cascade,
  primary key (owner_id, delegate_id),
  check (owner_id <> delegate_id)
);

alter table workspace_invites enable row level security;
alter table workspace_delegates enable row level security;
create policy owner_invites on workspace_invites using (owner_id = app_user_id());
create policy workspace_members on workspace_delegates for select
  using (owner_id = app_user_id() or delegate_id = app_user_id());
create policy owner_revokes on workspace_delegates for delete using (owner_id = app_user_id());
grant select, insert, update, delete on workspace_invites to jobagent_app;
grant select, delete on workspace_delegates to jobagent_app;

create function accept_workspace_invite(invite_hash text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor uuid := public.app_user_id();
  inviter uuid;
begin
  delete from public.workspace_invites i
  using public.users u
  where i.token_hash = invite_hash and i.expires_at > now() and u.id = actor
    and i.delegate_email = u.email and i.owner_id <> actor
  returning i.owner_id into inviter;
  if inviter is not null then
    insert into public.workspace_delegates values (inviter, actor) on conflict do nothing;
  end if;
  return inviter;
end;
$$;
revoke all on function accept_workspace_invite(text) from public;
grant execute on function accept_workspace_invite(text) to jobagent_app;

alter table gmail_alert_jobs add column status_actor_id uuid references users on delete set null;
alter table gmail_alert_jobs add column status_at timestamptz;
drop policy tenant_isolation on gmail_alert_jobs;
create policy gmail_jobs_read on gmail_alert_jobs for select using (
  user_id = app_user_id() or exists (
    select 1 from workspace_delegates d where d.owner_id = user_id and d.delegate_id = app_user_id()
  )
);
create policy gmail_jobs_insert on gmail_alert_jobs for insert with check (user_id = app_user_id());
create policy gmail_jobs_update on gmail_alert_jobs for update using (
  user_id = app_user_id() or exists (
    select 1 from workspace_delegates d where d.owner_id = user_id and d.delegate_id = app_user_id()
  )
);

create table resume_builder_documents (
  owner_id uuid not null references users on delete cascade,
  id text not null,
  data jsonb,
  updated_at bigint not null,
  deleted_at bigint,
  primary key (owner_id, id)
);
alter table resume_builder_documents enable row level security;
create policy document_workspace on resume_builder_documents using (
  owner_id = app_user_id() or exists (
    select 1 from workspace_delegates d where d.owner_id = resume_builder_documents.owner_id
      and d.delegate_id = app_user_id()
  )
);
grant select, insert, update on resume_builder_documents to jobagent_app;

-- CV tags (e.g. ".NET", "Node", "Angular"). Tags are metadata kept apart from resume_files,
-- so resume files stay immutable while tags can be edited.
alter table resume_files add constraint resume_files_id_user unique (id, user_id);

create table resume_tags (
  user_id uuid not null references users on delete cascade,
  resume_id uuid not null,
  tag text not null check (length(tag) between 1 and 30),
  primary key (resume_id, tag),
  -- The composite key guarantees a tag row always belongs to the resume's owner.
  foreign key (resume_id, user_id) references resume_files (id, user_id) on delete cascade
);
create index resume_tags_user_tag on resume_tags (user_id, tag);

alter table resume_tags enable row level security;
create policy tenant_isolation on resume_tags
  using (user_id = app_user_id()) with check (user_id = app_user_id());
grant select, insert, delete on resume_tags to jobagent_app;

-- Which of the user's CV tags each job mentions; filled in by matching.
alter table job_matches add column tag_hits text[] not null default '{}';
create index job_matches_tag_hits on job_matches using gin (tag_hits);

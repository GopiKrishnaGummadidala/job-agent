alter table job_preferences add constraint job_preferences_user_id_id_key unique (user_id, id);
alter table user_settings add column active_search_profile_id uuid;
alter table user_settings add constraint settings_active_search_profile
  foreign key (user_id, active_search_profile_id) references job_preferences (user_id, id)
  on delete set null (active_search_profile_id);

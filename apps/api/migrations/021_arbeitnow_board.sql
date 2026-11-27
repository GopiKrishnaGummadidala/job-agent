alter table boards drop constraint boards_kind_check;
alter table boards add constraint boards_kind_check
  check (kind in ('greenhouse', 'lever', 'ashby', 'personio', 'recruitee', 'workable', 'smartrecruiters', 'arbeitnow'));

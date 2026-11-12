-- Countries each job can be done from (ISO codes, 'EU' = Europe-wide), inferred from its location.
-- Null means not computed yet; the API fills these in on start-up and on every board refresh.
alter table jobs add column if not exists countries text[];
create index if not exists jobs_countries_idx on jobs using gin (countries);

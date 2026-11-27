import { Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, parse, UserId } from './auth';
import { audit, Db, Q } from './db';
import { loadPrefs, loadProfile, MatchingService } from './matching/matching.service';

const list = z.array(z.string().trim().min(1).max(100)).max(100);

const profileSchema = z.object({
  full_name: z.string().trim().max(200),
  email: z.union([z.literal(''), z.email().max(254)]),
  phone: z.string().trim().max(50),
  linkedin_url: z.union([z.literal(''), z.url().max(300)]),
  headline: z.string().trim().max(300),
  location: z.string().trim().max(200),
  work_authorization: z.string().trim().max(300),
  years_experience: z.number().int().min(0).max(70).nullable(),
  skills: list,
  languages: list,
  summary: z.string().trim().max(5000),
});

const prefsSchema = z.object({
  titles: list,
  keywords: list,
  locations: list,
  remote_ok: z.boolean(),
  salary_floor: z.number().int().min(0).max(10_000_000).nullable(),
  salary_target_eur: z.number().int().min(0).max(10_000_000).nullable().optional(),
  target_languages: list.optional(),
  target_engagements: list.optional(),
  excluded_companies: list,
  excluded_keywords: list,
  min_score: z.number().int().min(0).max(100),
});

const settingsSchema = z.object({
  ai_provider: z.enum(['none', 'ollama', 'openai', 'anthropic']),
  ai_model: z.string().trim().max(100),
  monthly_budget_usd: z.number().min(0).max(1000),
  daily_budget_usd: z.number().min(0).max(1000).optional(),
  auto_assess_local: z.boolean().optional(),
  resume_builder_url: z.union([z.literal(''), z.url().regex(/^https?:\/\//, 'Must be an http(s) URL').max(500)]),
});

export async function loadSettings(q: Q, userId: string) {
  await q('insert into user_settings (user_id) values ($1) on conflict do nothing', [userId]);
  const [s] = await q('select * from user_settings where user_id = $1', [userId]);
  return { ...s, monthly_budget_usd: Number(s.monthly_budget_usd), daily_budget_usd: Number(s.daily_budget_usd) };
}

function setClause(data: Record<string, unknown>, offset: number) {
  const keys = Object.keys(data);
  return { sql: keys.map((k, i) => `${k} = $${i + offset}`).join(', '), values: keys.map((k) => data[k]) };
}

@Controller('me')
@UseGuards(AuthGuard)
export class ProfileController {
  constructor(
    private db: Db,
    private matching: MatchingService,
  ) {}

  @Get('profile')
  get(@UserId() userId: string) {
    return this.db.asUser(userId, async (q) => ({
      profile: await loadProfile(q, userId),
      preferences: await loadPrefs(q, userId),
      settings: await loadSettings(q, userId),
      search_profiles: await q('select id, name from job_preferences where user_id = $1 order by name', [userId]),
    }));
  }

  @Put('profile')
  async putProfile(@UserId() userId: string, @Body() body: unknown) {
    const data = parse(profileSchema, body);
    await this.db.asUser(userId, async (q) => {
      await loadProfile(q, userId);
      const { sql, values } = setClause(data, 2);
      await q(`update candidate_profiles set ${sql}, updated_at = now() where user_id = $1`, [userId, ...values]);
      await audit(q, userId, 'profile.updated', null, { fields: Object.keys(data) });
    });
    await this.matching.recompute(userId);
    return this.get(userId);
  }

  @Put('preferences')
  async putPrefs(@UserId() userId: string, @Body() body: unknown) {
    const { profile_id, ...data } = parse(prefsSchema.extend({ profile_id: z.uuid().optional() }), body);
    await this.db.asUser(userId, async (q) => {
      const active = await loadPrefs(q, userId);
      const { sql, values } = setClause(data, 3);
      const rows = await q(`update job_preferences set ${sql} where user_id = $1 and id = $2 returning id`,
        [userId, profile_id ?? active.id, ...values]);
      if (!rows.length) throw new NotFoundException('Search profile not found.');
      await audit(q, userId, 'preferences.updated', null);
    });
    await this.matching.recompute(userId);
    return this.get(userId);
  }

  @Post('search-profiles')
  async createSearchProfile(@UserId() userId: string, @Body() body: unknown) {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), body);
    await this.db.asUser(userId, async (q) => {
      const active = await loadPrefs(q, userId);
      const [created] = await q(
        `insert into job_preferences (user_id, name, titles, keywords, locations, remote_ok, salary_floor,
           excluded_companies, excluded_keywords, min_score, salary_target_eur, target_languages, target_engagements)
         select user_id, $2, titles, keywords, locations, remote_ok, salary_floor,
           excluded_companies, excluded_keywords, min_score, salary_target_eur, target_languages, target_engagements
         from job_preferences where user_id = $1 and id = $3
         on conflict (user_id, name) do nothing returning id`, [userId, name, active.id],
      );
      if (!created) throw new ConflictException('A search profile already uses this name.');
      await loadSettings(q, userId);
      await q('update user_settings set active_search_profile_id = $2 where user_id = $1', [userId, created.id]);
    });
    await this.matching.recompute(userId);
    return this.get(userId);
  }

  @Put('search-profiles/:id/active')
  async activateSearchProfile(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.asUser(userId, async (q) => {
      const [profile] = await q('select id from job_preferences where user_id = $1 and id = $2', [userId, id]);
      if (!profile) throw new NotFoundException('Search profile not found.');
      await loadSettings(q, userId);
      await q('update user_settings set active_search_profile_id = $2 where user_id = $1', [userId, id]);
    });
    await this.matching.recompute(userId);
    return this.get(userId);
  }

  @Put('settings')
  async putSettings(@UserId() userId: string, @Body() body: unknown) {
    const data = parse(settingsSchema, body);
    await this.db.asUser(userId, async (q) => {
      await loadSettings(q, userId);
      const { sql, values } = setClause(data, 2);
      await q(`update user_settings set ${sql} where user_id = $1`, [userId, ...values]);
      await audit(q, userId, 'settings.updated', null, { ai_provider: data.ai_provider, ai_model: data.ai_model });
    });
    return this.get(userId);
  }

  @Get('dashboard')
  dashboard(@UserId() userId: string) {
    return this.db.asUser(userId, async (q) => {
      const prefs = await loadPrefs(q, userId);
      const minScore = prefs?.min_score ?? 40;
      const [c] = await q(
        `select
           (select count(*) from job_matches m join jobs j on j.id = m.job_id where j.closed_at is null)::int as jobs_found,
           (select count(*) from job_matches m join jobs j on j.id = m.job_id
              where j.closed_at is null and not m.filtered and m.score >= $1 and m.status <> 'dismissed')::int as matched,
           (select count(*) from application_drafts where status = 'awaiting_review')::int as awaiting_review,
           (select count(*) from application_drafts where status in ('approved', 'handed_off'))::int as approved,
           (select count(*) from applications)::int as submitted,
           (select count(*) from applications where submitted_at > now() - interval '30 days')::int as submitted_30d,
           (select count(*) from job_matches where status = 'saved')::int as shortlisted,
           (select count(*) from private_calendar_interviews where user_id = $2 and starts_at >= now())::int as upcoming_interviews,
           (select count(*) from job_sources)::int as sources,
           (select count(*) from resume_files)::int as resumes,
           (select coalesce(sum(est_cost_usd), 0) from ai_usage where at >= date_trunc('month', now()))::float as ai_spend_month`,
        [minScore, userId],
      );
      const providers = await q(
        `select b.kind, count(*)::int as runs,
                count(*) filter (where r.status = 'failed')::int as failures,
                coalesce(sum(r.jobs_inserted), 0)::int as inserted,
                coalesce(sum(r.duplicates_prevented), 0)::int as duplicates,
                max(r.ended_at) filter (where r.status = 'completed') as last_success
         from job_discovery_runs r
         join job_sources s on s.board_id = r.board_id and s.user_id = $1
         join boards b on b.id = r.board_id
         where r.started_at >= now() - interval '30 days'
         group by b.kind order by b.kind`, [userId],
      );
      const discovery = await q(
        `with days as (
           select (now() at time zone 'Europe/Berlin')::date - day_offset as day
           from generate_series(0, 6) as days(day_offset)
         ), seen as (
           select (j.first_seen_at at time zone 'Europe/Berlin')::date as day, count(*)::int as count
           from job_matches m join jobs j on j.id = m.job_id
           where m.user_id = $1 and j.first_seen_at >= ((select min(day) from days)::timestamp at time zone 'Europe/Berlin')
           group by 1
         )
         select days.day::text, coalesce(seen.count, 0) as count from days left join seen using (day) order by days.day`, [userId],
      );
      const activity = await q(`select type, entity_id, data, at from audit_events order by at desc limit 15`);
      return { ...c, min_score: minScore, activity, providers, discovery,
        duplicates_30d: providers.reduce((sum, provider) => sum + provider.duplicates, 0),
        discovered_today: discovery.at(-1)?.count ?? 0,
      };
    });
  }
}

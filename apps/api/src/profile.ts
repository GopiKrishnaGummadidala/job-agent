import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
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
  excluded_companies: list,
  excluded_keywords: list,
  min_score: z.number().int().min(0).max(100),
});

const settingsSchema = z.object({
  ai_provider: z.enum(['none', 'ollama', 'openai', 'anthropic']),
  ai_model: z.string().trim().max(100),
  monthly_budget_usd: z.number().min(0).max(1000),
  resume_builder_url: z.union([z.literal(''), z.url().regex(/^https?:\/\//, 'Must be an http(s) URL').max(500)]),
});

export async function loadSettings(q: Q, userId: string) {
  await q('insert into user_settings (user_id) values ($1) on conflict do nothing', [userId]);
  const [s] = await q('select * from user_settings where user_id = $1', [userId]);
  return { ...s, monthly_budget_usd: Number(s.monthly_budget_usd) };
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
    const data = parse(prefsSchema, body);
    await this.db.asUser(userId, async (q) => {
      await loadPrefs(q, userId);
      const { sql, values } = setClause(data, 2);
      await q(`update job_preferences set ${sql} where user_id = $1 and name = 'Default'`, [userId, ...values]);
      await audit(q, userId, 'preferences.updated', null);
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
      const [prefs] = await q(`select min_score from job_preferences where name = 'Default'`);
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
           (select count(*) from job_sources)::int as sources,
           (select count(*) from resume_files)::int as resumes,
           (select coalesce(sum(est_cost_usd), 0) from ai_usage where at >= date_trunc('month', now()))::float as ai_spend_month`,
        [minScore],
      );
      const activity = await q(`select type, entity_id, data, at from audit_events order by at desc limit 15`);
      return { ...c, min_score: minScore, activity };
    });
  }
}

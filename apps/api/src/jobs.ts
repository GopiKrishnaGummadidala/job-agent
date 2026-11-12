import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ASSESS_SYSTEM, ASSESS_VERSION, candidateBlock, jobBlock, parseAssessment } from './ai/prompts';
import { AiService } from './ai/ai.service';
import { AuthGuard, parse, UserId } from './auth';
import { audit, Db } from './db';
import { loadPrefs, loadProfile } from './matching/matching.service';
import { loadResumes, recommendResume } from './resumes';
import { BOARD_KINDS } from './sources/adapters';
import { EMPLOYMENT_TYPES, SENIORITIES, WORKPLACES } from './sources/classify';
import { EUROPE, EUROPE_WIDE } from './sources/countries';

/** A list filter given as "a,b" or as repeated parameters (?x=a&x=b). Repeat to keep commas in values. */
const list = (item: z.ZodType<string>, split = true) =>
  z
    .union([z.string().max(2000), z.array(z.string().max(300)).max(50)])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : split ? v.split(',') : [v]))
    .transform((a) => a.map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item).max(50) as z.ZodType<string[], string[]>);

const POSTED_WITHIN: Record<string, string> = { '1d': '1 day', '3d': '3 days', '7d': '7 days', '14d': '14 days', '30d': '30 days' };

const listQuery = z.object({
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(['new', 'saved', 'dismissed', 'all']).default('all'),
  /** Matches title, company or location. */
  q: z.string().trim().max(100).optional(),
  includeFiltered: z.enum(['true', 'false']).default('false'),
  /** CV tags, e.g. ".NET,Angular". */
  tags: list(z.string().max(30)),
  tagMode: z.enum(['any', 'all']).default('any'),
  posted: z.enum(['any', '1d', '3d', '7d', '14d', '30d']).default('any'),
  type: list(z.enum(EMPLOYMENT_TYPES)),
  workplace: list(z.enum(WORKPLACES)),
  seniority: list(z.enum(SENIORITIES)),
  source: list(z.enum(BOARD_KINDS)),
  company: list(z.string().max(200), false),
  /** ISO country codes; a country also matches Europe-wide postings when it is in Europe. */
  country: list(z.string().regex(/^[A-Z]{2}$/)),
  /** City or region text, matched against the posting's location. */
  location: z.string().trim().max(100).optional(),
});

const escapeLike = (s?: string) => (s ? `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);

@Controller('me/jobs')
@UseGuards(AuthGuard)
export class JobsController {
  constructor(
    private db: Db,
    private ai: AiService,
  ) {}

  @Get()
  list(@UserId() userId: string, @Query() query: unknown) {
    const f = parse(listQuery, query);
    const like = escapeLike(f.q);
    return this.db.asUser(userId, (q) =>
      q(
        `select j.id, j.company, j.title, j.location, j.remote, j.workplace, j.employment_type, j.seniority,
                j.url, j.posted_at, j.first_seen_at,
                m.score, m.ai_score, m.filtered, m.status, m.tag_hits, b.kind as source,
                d.id as draft_id, d.status as draft_status
         from job_matches m
         join jobs j on j.id = m.job_id
         join boards b on b.id = j.board_id
         left join application_drafts d on d.job_id = j.id
         where j.closed_at is null
           and ($1::int is null or m.score >= $1)
           and ($2 = 'all' and m.status <> 'dismissed' or m.status = $2)
           and ($3::text is null or j.title ilike $3 or j.company ilike $3 or j.location ilike $3)
           and ($4 or not m.filtered)
           and (cardinality($5::text[]) = 0
                or ($6 = 'any' and m.tag_hits && $5::text[])
                or ($6 = 'all' and m.tag_hits @> $5::text[]))
           and ($7::interval is null or coalesce(j.posted_at, j.first_seen_at) >= now() - $7::interval)
           and (cardinality($8::text[]) = 0 or j.employment_type = any($8))
           and (cardinality($9::text[]) = 0 or j.workplace = any($9))
           and (cardinality($10::text[]) = 0 or j.seniority = any($10))
           and (cardinality($11::text[]) = 0 or b.kind = any($11))
           and (cardinality($12::text[]) = 0 or j.company = any($12))
           and (cardinality($13::text[]) = 0 or j.countries && $13::text[]
                or ('${EUROPE_WIDE}' = any(j.countries) and $13::text[] && $14::text[]))
           and ($15::text is null or j.location ilike $15)
         order by coalesce(m.ai_score, m.score) desc, coalesce(j.posted_at, j.first_seen_at) desc
         limit 1000`,
        [
          f.minScore ?? null,
          f.status,
          like,
          f.includeFiltered === 'true',
          f.tags,
          f.tagMode,
          POSTED_WITHIN[f.posted] ?? null,
          f.type,
          f.workplace,
          f.seniority,
          f.source,
          f.company,
          f.country,
          EUROPE,
          escapeLike(f.location),
        ],
      ),
    );
  }

  /**
   * Filter options with counts, plus the numbers needed to explain an empty result:
   * how many jobs your preferences filtered out and how many sit below the minimum match.
   */
  @Get('facets')
  facets(@UserId() userId: string, @Query() query: unknown) {
    const { minScore } = parse(z.object({ minScore: z.coerce.number().int().min(0).max(100).default(40) }), query);
    return this.db.asUser(userId, async (q) => {
      const base = `from job_matches m join jobs j on j.id = m.job_id join boards b on b.id = j.board_id
                    where j.closed_at is null`;
      const [totals] = await q(
        `select count(*)::int as total_open,
                count(*) filter (where m.filtered)::int as filtered_out,
                count(*) filter (where not m.filtered and m.score < $1)::int as below_score,
                (select count(*) from job_sources)::int as sources
         ${base}`,
        [minScore],
      );
      const count = (col: string) =>
        q(`select ${col} as value, count(*)::int as n ${base} and not m.filtered group by 1 order by 2 desc, 1`);
      const profile = await loadProfile(q, userId);
      const prefs = await loadPrefs(q, userId);
      return {
        ...totals,
        profile_incomplete: !prefs.titles.length && !profile.skills.length && !prefs.keywords.length,
        employment_type: await count('j.employment_type'),
        workplace: await count('j.workplace'),
        seniority: await count('j.seniority'),
        source: await count('b.kind'),
        company: await count('j.company'),
        country: await q(
          `select c as value, count(*)::int as n
           from job_matches m join jobs j on j.id = m.job_id cross join lateral unnest(j.countries) as c
           where j.closed_at is null and not m.filtered group by 1 order by 2 desc, 1`,
        ),
      };
    });
  }

  @Get(':id')
  async get(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(userId, async (q) => {
      const [job] = await q(
        `select j.*, b.kind as source, m.score, m.filtered, m.reasons, m.unknowns, m.status,
                m.ai_score, m.ai_assessment, m.ai_content_hash = j.content_hash as ai_current,
                d.id as draft_id, d.status as draft_status
         from job_matches m join jobs j on j.id = m.job_id join boards b on b.id = j.board_id
         left join application_drafts d on d.job_id = j.id
         where j.id = $1`,
        [id],
      );
      if (!job) throw new NotFoundException();
      const profile = await loadProfile(q, userId);
      const prefs = await loadPrefs(q, userId);
      const resumes = await loadResumes(q);
      const settings = await q('select resume_builder_url from user_settings');
      return {
        ...job,
        resume: recommendResume(resumes, [...profile.skills, ...prefs.keywords], `${job.title}\n${job.description}`),
        resume_builder_url: settings[0]?.resume_builder_url ?? '',
      };
    });
  }

  @Patch(':id/status')
  async setStatus(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { status } = parse(z.object({ status: z.enum(['new', 'saved', 'dismissed']) }), body);
    return this.db.asUser(userId, async (q) => {
      const rows = await q('update job_matches set status = $2 where job_id = $1 returning job_id', [id, status]);
      if (!rows.length) throw new NotFoundException();
      return { id, status };
    });
  }

  /** Stage 2: optional AI assessment of one job. Cached until the posting changes. */
  @Post(':id/assess')
  async assess(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    const ctx = await this.db.asUser(userId, async (q) => {
      const [job] = await q(
        `select j.*, m.ai_assessment, m.ai_content_hash from job_matches m join jobs j on j.id = m.job_id where j.id = $1`,
        [id],
      );
      if (!job) throw new NotFoundException();
      const profile = await loadProfile(q, userId);
      const prefs = await loadPrefs(q, userId);
      const resumes = await loadResumes(q);
      const rec = recommendResume(resumes, [...profile.skills, ...prefs.keywords], `${job.title}\n${job.description}`);
      const resumeText = resumes.find((r) => r.id === rec.resumeId)?.extracted_text ?? '';
      return { job, profile, prefs, resumeText };
    });
    if (ctx.job.ai_assessment && ctx.job.ai_content_hash === ctx.job.content_hash) {
      return { ...ctx.job.ai_assessment, cached: true };
    }
    const result = await this.ai.run(userId, {
      task: 'assess',
      promptVersion: ASSESS_VERSION,
      system: ASSESS_SYSTEM,
      user: `${candidateBlock(ctx.profile, ctx.prefs, ctx.resumeText)}\n\n${jobBlock(ctx.job)}`,
      maxTokens: 1200,
    });
    const assessment = parseAssessment(result.text);
    if (!assessment) return { error: 'The model did not return a valid assessment. Try again or use another model.' };
    await this.db.asUser(userId, async (q) => {
      await q(
        `update job_matches set ai_score = $2, ai_assessment = $3, ai_content_hash = $4 where job_id = $1`,
        [id, assessment.score, JSON.stringify({ ...assessment, model: result.model }), ctx.job.content_hash],
      );
      await audit(q, userId, 'job.assessed', id, { model: result.model, score: assessment.score });
    });
    return { ...assessment, model: result.model, cached: false };
  }
}

import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JobAssessmentService } from './ai/job-assessment.service';
import { AuthGuard, parse, UserId } from './auth';
import { audit, Db } from './db';
import { loadPrefs, loadProfile } from './matching/matching.service';
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
    private assessments: JobAssessmentService,
  ) {}

  @Get()
  list(@UserId() userId: string, @Query() query: unknown) {
    const f = parse(listQuery, query);
    const like = escapeLike(f.q);
    return this.db.asUser(userId, (q) =>
      q(
        `with eligible as (
         select j.id, j.company, j.title, j.location, j.remote, j.workplace, j.employment_type, j.seniority,
                j.url, j.posted_at, j.first_seen_at,
                m.score, m.ai_score, m.filtered, m.status, m.tag_hits, b.kind as source,
                d.id as draft_id, d.status as draft_status,
                (d.id is not null or m.status <> 'new' or exists (select 1 from applications a where a.job_id = j.id)) as tracked,
                case
                  when parent.job_id is not null then 'manual:' || parent.canonical_job_id
                  when children.linked then 'manual:' || j.id
                  when r.duplicate_key is not null and not exists (
                    select 1 from job_source_references repeated
                    join jobs other on other.id = repeated.job_id and other.closed_at is null
                    where md5(repeated.duplicate_key) = md5(r.duplicate_key) and repeated.duplicate_key = r.duplicate_key
                    group by repeated.board_id having count(*) > 1
                  ) then coalesce('manual:' || related_group.canonical_job_id, 'auto:' || r.duplicate_key)
                  else 'job:' || j.id
                end as group_key,
                (parent.job_id is null) as preferred
         from job_matches m
         join jobs j on j.id = m.job_id
         join boards b on b.id = j.board_id
         left join application_drafts d on d.job_id = j.id
         left join job_source_references r on r.board_id = j.board_id and r.external_id = j.external_id
         left join job_duplicate_links parent on parent.job_id = j.id and parent.user_id = m.user_id
         left join lateral (
           select exists(select 1 from job_duplicate_links l where l.user_id = m.user_id and l.canonical_job_id = j.id) as linked
         ) children on true
         left join lateral (
           select l.canonical_job_id
           from job_duplicate_links l join job_source_references member on member.job_id in (l.job_id, l.canonical_job_id)
           where l.user_id = m.user_id and member.duplicate_key = r.duplicate_key
           group by l.canonical_job_id
           order by l.canonical_job_id limit 1
         ) related_group on true
         where j.closed_at is null
           and ($1::int is null or m.score >= $1)
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
         ), ranked as (
           select eligible.*, row_number() over (
             partition by group_key order by tracked desc, preferred desc, first_seen_at, id
           ) as row_no, max(coalesce(posted_at, first_seen_at)) over (partition by group_key) as group_posted
           from eligible
         )
         select id, company, title, location, remote, workplace, employment_type, seniority, url, posted_at,
                first_seen_at, score, ai_score, filtered, status, tag_hits, source, draft_id, draft_status
         from ranked where (row_no = 1 or tracked) and ($2 = 'all' and status <> 'dismissed' or status = $2)
         order by group_posted desc, coalesce(ai_score, score) desc, id
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
                m.ai_score, m.ai_assessment,
                d.id as draft_id, d.status as draft_status
         from job_matches m join jobs j on j.id = m.job_id join boards b on b.id = j.board_id
         left join application_drafts d on d.job_id = j.id
         where j.id = $1`,
        [id],
      );
      if (!job) throw new NotFoundException();
      const context = await this.assessments.assessmentContext(q, userId, job);
      const cached = await this.assessments.cachedAssessment(q, id, context.key);
      return {
        ...job,
        ai_score: cached?.score ?? job.ai_score,
        ai_assessment: cached ?? job.ai_assessment,
        ai_current: Boolean(cached),
        resume: context.recommendation,
        resume_builder_url: context.builderUrl,
      };
    });
  }

  @Get(':id/sources')
  async sources(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(userId, async (q) => {
      if (!(await q('select 1 from job_matches where user_id = $1 and job_id = $2', [userId, id])).length) {
        throw new NotFoundException();
      }
      return q(
        `select b.kind, b.token, r.external_id, r.source_url, r.first_seen_at, r.last_seen_at
         from job_source_references r join boards b on b.id = r.board_id
         where r.job_id = $1 or (
           exists (select 1 from job_matches m where m.job_id = r.job_id and m.user_id = $2)
           and (
             exists (select 1 from job_source_references source where source.job_id = $1 and source.duplicate_key = r.duplicate_key)
             or exists (
               select 1 from job_duplicate_links link where link.user_id = $2
               and ((link.job_id = r.job_id and link.canonical_job_id = $1) or (link.job_id = $1 and link.canonical_job_id = r.job_id))
             )
           )
         )
         order by (r.job_id = $1) desc, r.first_seen_at, b.kind, r.external_id`,
        [id, userId],
      );
    });
  }

  @Get(':id/duplicates')
  async duplicateCandidates(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(userId, async (q) => {
      const [anchor] = await q(
        'select j.* from jobs j join job_matches m on m.job_id = j.id where j.id = $1 and m.user_id = $2', [id, userId],
      );
      if (!anchor) throw new NotFoundException('Job not found.');
      return q(
        `select j.id, j.title, j.company, j.location, j.url, b.kind as source
         from jobs j join job_matches m on m.job_id = j.id join boards b on b.id = j.board_id
         where m.user_id = $1 and j.id <> $2 and j.closed_at is null
           and not exists (select 1 from job_duplicate_links l where l.user_id = $1 and l.job_id = j.id)
           and lower(btrim(j.company)) = lower(btrim($3)) and lower(btrim(j.title)) = lower(btrim($4))
           and (lower(btrim(j.location)) = lower(btrim($5)) or (j.content_hash = $6 and j.description <> ''))
         order by j.first_seen_at desc limit 12`,
        [userId, id, anchor.company, anchor.title, anchor.location, anchor.content_hash],
      );
    });
  }

  @Post('duplicates/merge')
  mergeDuplicates(@UserId() userId: string, @Body() body: unknown) {
    const { canonicalId, duplicateId } = parse(z.object({ canonicalId: z.uuid(), duplicateId: z.uuid() }), body);
    if (canonicalId === duplicateId) throw new BadRequestException('Choose two different jobs.');
    return this.db.asUser(userId, async (q) => {
      await q('select pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
      const rows = await q(
        `select m.job_id, m.status,
           (exists (select 1 from application_drafts d where d.user_id = $1 and d.job_id = m.job_id)
             or exists (select 1 from applications a where a.user_id = $1 and a.job_id = m.job_id)) as has_application
         from job_matches m where m.user_id = $1 and m.job_id = any($2::uuid[]) for update`,
        [userId, [canonicalId, duplicateId]],
      );
      if (rows.length !== 2) throw new NotFoundException('One or both jobs are unavailable.');
      if (rows.every((row) => row.has_application || row.status !== 'new')) {
        throw new ConflictException('Both jobs have tracking history. Keep them separate.');
      }
      if ((await q(
        `select 1 from job_duplicate_links
         where user_id = $1 and (job_id = any($2::uuid[]) or canonical_job_id = $3)`,
        [userId, [canonicalId, duplicateId], duplicateId],
      )).length) throw new ConflictException('Use the original job as the main record when linking another posting.');
      const tracked = rows.find((row) => row.has_application || row.status !== 'new');
      const primary = tracked?.job_id ?? canonicalId;
      const alias = primary === canonicalId ? duplicateId : canonicalId;
      if (alias === canonicalId && (await q(
        'select 1 from job_duplicate_links where user_id = $1 and canonical_job_id = $2', [userId, alias],
      )).length) throw new ConflictException('The jobs already belong to different groups.');
      await q('insert into job_duplicate_links (user_id, job_id, canonical_job_id) values ($1, $2, $3)', [userId, alias, primary]);
      await audit(q, userId, 'job.duplicates_linked', primary, { duplicate_id: alias });
      return { id: primary };
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

  @Post(':id/assess')
  assess(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.assessments.assess(userId, id);
  }
}

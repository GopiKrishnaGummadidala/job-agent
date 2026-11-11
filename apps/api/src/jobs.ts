import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ASSESS_SYSTEM, ASSESS_VERSION, candidateBlock, jobBlock, parseAssessment } from './ai/prompts';
import { AiService } from './ai/ai.service';
import { AuthGuard, parse, UserId } from './auth';
import { audit, Db } from './db';
import { loadPrefs, loadProfile } from './matching/matching.service';
import { recommendResume } from './resumes';

const listQuery = z.object({
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(['new', 'saved', 'dismissed', 'all']).default('all'),
  q: z.string().trim().max(100).optional(),
  includeFiltered: z.enum(['true', 'false']).default('false'),
});

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
    return this.db.asUser(userId, (q) =>
      q(
        `select j.id, j.company, j.title, j.location, j.remote, j.url, j.posted_at, j.first_seen_at,
                m.score, m.ai_score, m.filtered, m.status, b.kind as source,
                d.id as draft_id, d.status as draft_status
         from job_matches m
         join jobs j on j.id = m.job_id
         join boards b on b.id = j.board_id
         left join application_drafts d on d.job_id = j.id
         where j.closed_at is null
           and ($1::int is null or m.score >= $1)
           and ($2 = 'all' and m.status <> 'dismissed' or m.status = $2)
           and ($3::text is null or j.title ilike '%' || $3 || '%' or j.company ilike '%' || $3 || '%')
           and ($4 or not m.filtered)
         order by coalesce(m.ai_score, m.score) desc, j.first_seen_at desc
         limit 1000`,
        [f.minScore ?? null, f.status, f.q || null, f.includeFiltered === 'true'],
      ),
    );
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
      const resumes = await q('select id, filename, extracted_text from resume_files order by uploaded_at desc');
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
      const resumes = await q('select id, filename, extracted_text from resume_files');
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

import { createHash } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ASSESS_SYSTEM, ASSESS_VERSION, candidateBlock, jobBlock, parseAssessment, type PromptJob } from './prompts';
import { AiService } from './ai.service';
import { audit, Db, type Q } from '../db';
import { loadSettings } from '../profile';
import { loadPrefs, loadProfile } from '../matching/matching.service';
import { loadResumes, recommendResume } from '../resumes';
import { config } from '../config';

@Injectable()
export class JobAssessmentService {
  private readonly assessments = new Map<string, Promise<object>>();
  private readonly autoRunning = new Set<string>();
  private readonly log = new Logger(JobAssessmentService.name);

  constructor(private db: Db, private ai: AiService) {}

  async automaticForBoard(userId: string, boardId: string) {
    const endpoint = URL.parse(config.ollamaBaseUrl);
    if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || this.autoRunning.has(userId)) return;
    this.autoRunning.add(userId);
    try {
      const candidates = await this.db.asUser(userId, async (q) => {
        const settings = await loadSettings(q, userId);
        if (!settings.auto_assess_local || settings.ai_provider !== 'ollama' || !settings.ai_model) return [];
        const prefs = await loadPrefs(q, userId);
        const [{ used }] = await q(
          `select count(*)::int as used from ai_usage where user_id = $1 and task = 'assess' and provider = 'ollama'
           and at >= date_trunc('day', now(), 'Europe/Berlin')`, [userId],
        );
        return q(
          `select j.id from jobs j join job_matches m on m.job_id = j.id and m.user_id = $1
           where j.board_id = $2 and j.closed_at is null and j.description <> ''
             and not m.filtered and m.status <> 'dismissed' and m.ai_assessment is null and m.score >= $3
           order by m.score desc, j.first_seen_at desc, j.id limit $4`,
          [userId, boardId, Math.max(70, prefs.min_score), Math.max(0, 3 - used)],
        );
      });
      for (const candidate of candidates) await this.assess(userId, candidate.id, true);
    } catch {
      this.log.warn('Automatic local assessment could not complete; check the Ollama connection.');
    } finally {
      this.autoRunning.delete(userId);
    }
  }

  async assessmentContext(q: Q, userId: string, job: PromptJob & { content_hash: string }) {
    const profile = await loadProfile(q, userId);
    const prefs = await loadPrefs(q, userId);
    const resumes = await loadResumes(q);
    const recommendation = recommendResume(resumes, [...profile.skills, ...prefs.keywords], `${job.title}\n${job.description}`);
    const resume = resumes.find((r) => r.id === recommendation.resumeId);
    const settings = await loadSettings(q, userId);
    const model = { provider: String(settings.ai_provider), model: String(settings.ai_model) };
    const prompt = `${candidateBlock(profile, prefs, resume?.extracted_text ?? '')}\n\n${jobBlock(job)}`;
    const key = createHash('sha256').update(JSON.stringify([
      ASSESS_VERSION, ASSESS_SYSTEM, model, job.content_hash, resume?.id, resume?.sha256, prefs, prompt,
    ])).digest('hex');
    return { key, model, prompt, recommendation, builderUrl: settings.resume_builder_url ?? '', automaticEnabled: settings.auto_assess_local === true };
  }

  async cachedAssessment(q: Q, jobId: string, key: string) {
    const [cached] = await q('select assessment from job_assessment_cache where job_id = $1 and cache_key = $2', [jobId, key]);
    return cached?.assessment;
  }

  /** Stage 2: optional AI assessment of one job and its recommended CV version. */
  async assess(userId: string, id: string, localOnly = false) {
    const ctx = await this.db.asUser(userId, async (q) => {
      const [job] = await q(
        `select j.* from job_matches m join jobs j on j.id = m.job_id where j.id = $1`,
        [id],
      );
      if (!job) throw new NotFoundException();
      const context = await this.assessmentContext(q, userId, job);
      return { ...context, contentHash: job.content_hash, cached: await this.cachedAssessment(q, id, context.key) };
    });
    if (localOnly && (ctx.model.provider !== 'ollama' || !ctx.automaticEnabled)) return null;
    if (ctx.cached) return { ...ctx.cached, cached: true };
    const key = `${userId}:${id}:${ctx.key}`;
    const running = this.assessments.get(key);
    if (running) return running;
    const work = this.runAssessment(userId, id, ctx).finally(() => this.assessments.delete(key));
    this.assessments.set(key, work);
    return work;
  }

  private async runAssessment(userId: string, id: string, ctx: {
    prompt: string; model: { provider: string; model: string }; key: string; contentHash: string;
  }) {
    const cached = await this.db.asUser(userId, (q) => this.cachedAssessment(q, id, ctx.key));
    if (cached) return { ...cached, cached: true };
    const result = await this.ai.run(userId, {
      task: 'assess',
      promptVersion: ASSESS_VERSION,
      system: ASSESS_SYSTEM,
      user: ctx.prompt,
      maxTokens: 1200,
      expectedModel: ctx.model,
    });
    const assessment = parseAssessment(result.text);
    if (!assessment) return { error: 'The model did not return a valid assessment. Try again or use another model.' };
    const saved = { ...assessment, model: result.model };
    await this.db.asUser(userId, async (q) => {
      const inserted = await q(
        `insert into job_assessment_cache (user_id, job_id, cache_key, assessment)
         select user_id, job_id, $2, $3 from job_matches where job_id = $1
         on conflict do nothing returning cache_key`, [id, ctx.key, JSON.stringify(saved)],
      );
      if (!inserted.length) return;
      await q(
        `update job_matches set ai_score = $2, ai_assessment = $3, ai_content_hash = $4
         where job_id = $1 and exists (select 1 from jobs where id = $1 and content_hash = $4)`,
        [id, assessment.score, JSON.stringify(saved), ctx.contentHash],
      );
      await audit(q, userId, 'job.assessed', id, { model: result.model, score: assessment.score });
    });
    return { ...saved, cached: false };
  }
}

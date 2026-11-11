import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AiService } from './ai/ai.service';
import { candidateBlock, COVER_LETTER_SYSTEM, COVER_LETTER_VERSION, jobBlock, templateCoverLetter } from './ai/prompts';
import { AssistService } from './assist';
import { AuthGuard, parse, UserId } from './auth';
import { audit, Db, Q } from './db';
import { hasTerm } from './matching/score';
import { loadPrefs, loadProfile } from './matching/matching.service';
import { loadSettings } from './profile';
import { recommendResume } from './resumes';

const answer = z.object({ question: z.string().trim().min(1).max(500), answer: z.string().trim().max(5000) });
const patchSchema = z.object({
  cover_letter: z.string().max(10_000).optional(),
  answers: z.array(answer).max(50).optional(),
  resume_id: z.uuid().nullable().optional(),
  notes: z.string().max(5000).optional(),
});

/**
 * Everything that is submitted to the employer. Approval binds to this hash, so changing any
 * of it after approval invalidates the approval. Private notes are deliberately excluded.
 */
export function draftHash(d: { job_id: string; apply_url: string; resume_sha256: string | null; cover_letter: string; answers: unknown }) {
  return createHash('sha256')
    .update(JSON.stringify([d.job_id, d.apply_url, d.resume_sha256 ?? null, d.cover_letter, d.answers]))
    .digest('hex');
}

const EDITABLE = ['awaiting_review', 'approved', 'handed_off', 'manual_action_required'];

async function loadDraft(q: Q, id: string) {
  const [d] = await q(
    `select d.*, j.title, j.company, j.location, j.url as job_url, j.apply_url, j.closed_at, b.kind as source,
            r.filename as resume_filename, r.sha256 as resume_sha256,
            a.id as approval_id, a.approved_at, a.content_hash as approved_hash
     from application_drafts d
     join jobs j on j.id = d.job_id join boards b on b.id = j.board_id
     left join resume_files r on r.id = d.resume_id
     left join lateral (select * from approvals ap where ap.draft_id = d.id and ap.revoked_at is null
                        order by ap.approved_at desc limit 1) a on true
     where d.id = $1`,
    [id],
  );
  if (!d) throw new NotFoundException();
  return { ...d, approval_valid: !!d.approval_id && d.approved_hash === d.content_hash };
}

@Controller('me')
@UseGuards(AuthGuard)
export class DraftsController {
  constructor(
    private db: Db,
    private ai: AiService,
    private assist: AssistService,
  ) {}

  @Get('application-drafts')
  list(@UserId() userId: string) {
    return this.db.asUser(userId, (q) =>
      q(
        `select d.id, d.job_id, d.status, d.updated_at, d.cover_letter_source, j.title, j.company, j.location,
                j.closed_at, m.score, r.filename as resume_filename
         from application_drafts d join jobs j on j.id = d.job_id
         left join job_matches m on m.job_id = d.job_id
         left join resume_files r on r.id = d.resume_id
         where d.status <> 'submitted'
         order by (d.status = 'awaiting_review') desc, d.updated_at desc`,
      ),
    );
  }

  @Get('application-drafts/:id')
  get(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(userId, (q) => loadDraft(q, id));
  }

  /** Prepares a draft for review. Background jobs may prepare, but only the user can approve. */
  @Post('jobs/:jobId/prepare')
  async prepare(@UserId() userId: string, @Param('jobId', ParseUUIDPipe) jobId: string) {
    const ctx = await this.db.asUser(userId, async (q) => {
      const [existing] = await q('select id from application_drafts where job_id = $1', [jobId]);
      if (existing) return { existing: existing.id as string };
      const [job] = await q(
        `select j.* from job_matches m join jobs j on j.id = m.job_id where j.id = $1 and j.closed_at is null`,
        [jobId],
      );
      if (!job) throw new NotFoundException('Job not found or no longer open.');
      const profile = await loadProfile(q, userId);
      const prefs = await loadPrefs(q, userId);
      const settings = await loadSettings(q, userId);
      const resumes = await q('select id, filename, sha256, extracted_text from resume_files');
      const terms = [...profile.skills, ...prefs.keywords];
      const rec = recommendResume(resumes, terms, `${job.title}\n${job.description}`);
      const resume = resumes.find((r) => r.id === rec.resumeId) ?? null;
      return { job, profile, prefs, settings, resume, terms };
    });
    if ('existing' in ctx) return this.get(userId, ctx.existing!);

    const { job, profile, prefs, settings, resume, terms } = ctx;
    let letter: string;
    let source = 'template';
    if (settings.ai_provider !== 'none') {
      const result = await this.ai.run(userId, {
        task: 'cover_letter',
        promptVersion: COVER_LETTER_VERSION,
        system: COVER_LETTER_SYSTEM,
        user: `${candidateBlock(profile, prefs, resume?.extracted_text ?? '')}\n\n${jobBlock(job)}`,
        maxTokens: 1500,
      });
      letter = result.text;
      source = `${result.provider}:${result.model}`;
    } else {
      const matched = terms.filter((t: string) => hasTerm(`${job.title}\n${job.description}`, t));
      letter = templateCoverLetter(job, profile, matched);
    }

    return this.db.asUser(userId, async (q) => {
      const hash = draftHash({
        job_id: jobId,
        apply_url: job.apply_url,
        resume_sha256: resume?.sha256 ?? null,
        cover_letter: letter,
        answers: [],
      });
      const [row] = await q(
        `insert into application_drafts (user_id, job_id, resume_id, cover_letter, cover_letter_source, content_hash)
         values ($1, $2, $3, $4, $5, $6) on conflict (user_id, job_id) do nothing returning id`,
        [userId, jobId, resume?.id ?? null, letter, source, hash],
      );
      if (!row) return loadDraft(q, (await q('select id from application_drafts where job_id = $1', [jobId]))[0].id);
      await audit(q, userId, 'draft.prepared', row.id, { job_id: jobId, cover_letter_source: source });
      return loadDraft(q, row.id);
    });
  }

  @Patch('application-drafts/:id')
  update(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const patch = parse(patchSchema, body);
    return this.db.asUser(userId, async (q) => {
      const d = await loadDraft(q, id);
      if (!EDITABLE.includes(d.status)) throw new ConflictException(`A ${d.status} application cannot be edited.`);
      if (patch.resume_id) {
        const [r] = await q('select id from resume_files where id = $1', [patch.resume_id]);
        if (!r) throw new BadRequestException('Unknown resume.');
      }
      const next = {
        cover_letter: patch.cover_letter ?? d.cover_letter,
        answers: patch.answers ?? d.answers,
        resume_id: patch.resume_id === undefined ? d.resume_id : patch.resume_id,
        notes: patch.notes ?? d.notes,
      };
      const [sha] = next.resume_id ? await q('select sha256 from resume_files where id = $1', [next.resume_id]) : [];
      const hash = draftHash({
        job_id: d.job_id,
        apply_url: d.apply_url,
        resume_sha256: sha?.sha256 ?? null,
        cover_letter: next.cover_letter,
        answers: next.answers,
      });
      const contentChanged = hash !== d.content_hash;
      let status = d.status;
      if (contentChanged && d.approval_id) {
        await q('update approvals set revoked_at = now() where draft_id = $1 and revoked_at is null', [id]);
        status = 'awaiting_review';
        await audit(q, userId, 'approval.invalidated', id, { reason: 'content changed after approval' });
      }
      await q(
        `update application_drafts set cover_letter = $2, answers = $3, resume_id = $4, notes = $5,
                content_hash = $6, status = $7, updated_at = now() where id = $1`,
        [id, next.cover_letter, JSON.stringify(next.answers), next.resume_id, next.notes, hash, status],
      );
      if (contentChanged) await audit(q, userId, 'draft.edited', id);
      return loadDraft(q, id);
    });
  }

  /** The client sends the hash of the exact content the user reviewed; a stale view cannot be approved. */
  @Post('application-drafts/:id/approve')
  @HttpCode(200)
  approve(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { content_hash } = parse(z.object({ content_hash: z.string().length(64) }), body);
    return this.db.asUser(userId, async (q) => {
      const d = await loadDraft(q, id);
      if (d.closed_at) throw new ConflictException('This job posting has closed.');
      if (!['awaiting_review', 'manual_action_required'].includes(d.status)) {
        if (d.approval_valid) return d;
        throw new ConflictException(`A ${d.status} application cannot be approved.`);
      }
      if (content_hash !== d.content_hash) {
        throw new ConflictException('The application changed since you opened it. Review it again before approving.');
      }
      if (!d.resume_id) throw new BadRequestException('Select a resume before approving.');
      const [a] = await q(
        'insert into approvals (user_id, draft_id, content_hash) values ($1, $2, $3) returning id',
        [userId, id, content_hash],
      );
      await q(`update application_drafts set status = 'approved', updated_at = now() where id = $1`, [id]);
      await audit(q, userId, 'draft.approved', id, { approval_id: a.id, content_hash });
      return loadDraft(q, id);
    });
  }

  @Post('application-drafts/:id/reject')
  @HttpCode(200)
  reject(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(userId, async (q) => {
      const d = await loadDraft(q, id);
      if (d.status === 'submitted') throw new ConflictException('This application was already submitted.');
      await q('update approvals set revoked_at = now() where draft_id = $1 and revoked_at is null', [id]);
      await q(`update application_drafts set status = 'rejected', updated_at = now() where id = $1`, [id]);
      await audit(q, userId, 'draft.rejected', id);
      return loadDraft(q, id);
    });
  }

  @Post('application-drafts/:id/reopen')
  @HttpCode(200)
  reopen(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(userId, async (q) => {
      const d = await loadDraft(q, id);
      if (d.status !== 'rejected') throw new ConflictException('Only rejected drafts can be reopened.');
      await q(`update application_drafts set status = 'awaiting_review', updated_at = now() where id = $1`, [id]);
      await audit(q, userId, 'draft.reopened', id);
      return loadDraft(q, id);
    });
  }

  /** Opens the apply page and pre-fills it. Requires a valid approval of the current content. */
  @Post('application-drafts/:id/assist')
  @HttpCode(200)
  async startAssist(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    const { d, profile, resume } = await this.db.asUser(userId, async (q) => {
      const d = await loadDraft(q, id);
      if (!d.approval_valid) throw new ConflictException('Approve this application before opening the apply page.');
      if (d.status === 'submitted') throw new ConflictException('This application was already submitted.');
      const profile = await loadProfile(q, userId);
      const [resume] = await q('select filename, content from resume_files where id = $1', [d.resume_id]);
      return { d, profile, resume };
    });
    const report = await this.assist.open({
      draftId: id,
      applyUrl: d.apply_url,
      fullName: profile.full_name,
      email: profile.email,
      phone: profile.phone,
      linkedinUrl: profile.linkedin_url,
      location: profile.location,
      coverLetter: d.cover_letter,
      answers: d.answers,
      resume: resume ?? null,
    });
    await this.db.asUser(userId, async (q) => {
      await q(`update application_drafts set status = 'handed_off', updated_at = now() where id = $1 and status = 'approved'`, [id]);
      await audit(q, userId, 'draft.assist_opened', id, report);
    });
    return report;
  }

  /** Manual hand-off: everything the user needs to paste into the employer's form. */
  @Post('application-drafts/:id/handoff')
  @HttpCode(200)
  handoff(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(userId, async (q) => {
      const d = await loadDraft(q, id);
      if (!d.approval_valid) throw new ConflictException('Approve this application first.');
      await q(`update application_drafts set status = 'handed_off', updated_at = now() where id = $1 and status = 'approved'`, [id]);
      await audit(q, userId, 'draft.handed_off', id);
      return loadDraft(q, id);
    });
  }

  /**
   * Records that the user submitted the application on the employer's site. Requires a valid
   * approval and an Idempotency-Key; repeated calls return the same application.
   */
  @Post('application-drafts/:id/submitted')
  @HttpCode(200)
  submitted(
    @UserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    if (!key || !/^[\w-]{8,100}$/.test(key)) throw new BadRequestException('An Idempotency-Key header is required.');
    return this.db.asUser(userId, async (q) => {
      const [prior] = await q('select * from applications where idempotency_key = $1 or draft_id = $2', [key, id]);
      if (prior) return prior;
      const d = await loadDraft(q, id);
      if (!d.approval_valid) throw new ConflictException('This application is not approved in its current form.');
      const snapshot = {
        job: { id: d.job_id, title: d.title, company: d.company, apply_url: d.apply_url },
        resume: { id: d.resume_id, filename: d.resume_filename, sha256: d.resume_sha256 },
        cover_letter: d.cover_letter,
        answers: d.answers,
        content_hash: d.content_hash,
      };
      const [app] = await q(
        `insert into applications (user_id, job_id, draft_id, approval_id, idempotency_key, snapshot)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [userId, d.job_id, id, d.approval_id, key, JSON.stringify(snapshot)],
      );
      await q(`update application_drafts set status = 'submitted', updated_at = now() where id = $1`, [id]);
      await audit(q, userId, 'application.submitted', app.id, { draft_id: id, approval_id: d.approval_id });
      return app;
    });
  }

  @Get('applications')
  applications(@UserId() userId: string) {
    return this.db.asUser(userId, (q) =>
      q(
        `select a.id, a.submitted_at, a.snapshot->'job' as job, a.snapshot->'resume' as resume, a.draft_id
         from applications a order by a.submitted_at desc`,
      ),
    );
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AuthGuard, parse, UserId } from './auth';
import { audit, Db, Q } from './db';
import { MatchingService } from './matching/matching.service';
import { hasTerm, tagMatches } from './matching/score';

const MAX_BYTES = 5 * 1024 * 1024;
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function detectType(buf: Buffer, filename: string): string | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return PDF;
  // DOCX is a ZIP container; require the extension too so other ZIPs are rejected.
  if (buf[0] === 0x50 && buf[1] === 0x4b && /\.docx$/i.test(filename)) return DOCX;
  return null;
}

export async function extractText(buf: Buffer, mime: string): Promise<string> {
  try {
    if (mime === PDF) {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await pdfText(pdf, { mergePages: true });
      return String(text).slice(0, 100_000);
    }
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ buffer: buf })).value.slice(0, 100_000);
  } catch {
    return '';
  }
}

export interface ResumeRecommendation {
  resumeId: string | null;
  filename: string | null;
  /** Tags of the recommended CV that the job mentions. */
  tagHits: string[];
  tags: string[];
  matched: string[];
  /** Skills the job mentions and the user's profile lists, but this resume does not mention. */
  missing: string[];
  candidates: { id: string; filename: string; tags: string[]; tagHits: string[]; matched: number }[];
}

export interface ResumeForMatching {
  id: string;
  filename: string;
  extracted_text: string;
  tags?: string[];
}

/**
 * Picks the existing resume that fits the job best: first by how many of its tags the job
 * mentions (e.g. a ".NET" CV for a C# role), then by job-relevant skills it covers.
 * Never modifies a resume.
 */
export function recommendResume(resumes: ResumeForMatching[], terms: string[], jobText: string): ResumeRecommendation {
  const relevant = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].filter((t) => hasTerm(jobText, t));
  const scored = resumes.map((r) => ({
    r,
    tagHits: (r.tags ?? []).filter((t) => tagMatches(jobText, t)),
    matched: relevant.filter((t) => hasTerm(r.extracted_text, t)),
  }));
  scored.sort((a, b) => b.tagHits.length - a.tagHits.length || b.matched.length - a.matched.length);
  const best = scored[0];
  return {
    resumeId: best?.r.id ?? null,
    filename: best?.r.filename ?? null,
    tagHits: best?.tagHits ?? [],
    tags: best?.r.tags ?? [],
    matched: best?.matched ?? [],
    missing: best ? relevant.filter((t) => !best.matched.includes(t)) : relevant,
    candidates: scored.map((s) => ({
      id: s.r.id,
      filename: s.r.filename,
      tags: s.r.tags ?? [],
      tagHits: s.tagHits,
      matched: s.matched.length,
    })),
  };
}

/** The user's resumes with tags, for matching. Runs inside Db.asUser, so only that user's rows. */
export function loadResumes(q: Q) {
  return q<ResumeForMatching & { sha256: string }>(
    `select r.id, r.filename, r.sha256, r.extracted_text,
            coalesce((select array_agg(t.tag order by t.tag) from resume_tags t where t.resume_id = r.id), '{}') as tags
     from resume_files r order by r.uploaded_at desc`,
  );
}

const tagSchema = z.array(z.string().trim().max(30).regex(/^[^,]*$/, 'Tags cannot contain commas')).max(20);

/**
 * Replaces a resume's tags. Tags are compared case-insensitively and reuse the spelling already
 * used on the user's other CVs, so ".net" and ".NET" become one filter option.
 */
export async function setResumeTags(q: Q, userId: string, resumeId: string, input: string[]): Promise<string[]> {
  const existing: string[] = (await q('select distinct tag from resume_tags where resume_id <> $1', [resumeId])).map((r) => r.tag);
  const byLower = new Map(existing.map((t) => [t.toLowerCase(), t]));
  const tags = new Map<string, string>();
  for (const raw of input) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (!tags.has(key)) tags.set(key, byLower.get(key) ?? t);
  }
  await q('delete from resume_tags where resume_id = $1', [resumeId]);
  const list = [...tags.values()];
  if (list.length) {
    await q('insert into resume_tags (user_id, resume_id, tag) select $1, $2, unnest($3::text[])', [userId, resumeId, list]);
  }
  return list.sort();
}

@Controller('me/resumes')
@UseGuards(AuthGuard)
export class ResumesController {
  constructor(
    private db: Db,
    private matching: MatchingService,
  ) {}

  @Get()
  list(@UserId() userId: string) {
    return this.db.asUser(userId, (q) =>
      q(
        `select id, filename, mime_type, size_bytes, sha256, uploaded_at, length(extracted_text) > 0 as has_text,
                left(extracted_text, 600) as preview,
                coalesce((select array_agg(t.tag order by t.tag) from resume_tags t where t.resume_id = r.id), '{}') as tags,
                (select count(*) from application_drafts d where d.resume_id = r.id)::int as used_by
         from resume_files r order by uploaded_at desc`,
      ),
    );
  }

  /** All tags in use, for the Job Explorer filter. */
  @Get('tags')
  tags(@UserId() userId: string) {
    return this.db.asUser(userId, (q) =>
      q('select tag, count(*)::int as resumes from resume_tags group by tag order by lower(tag)'),
    );
  }

  @Put(':id/tags')
  async putTags(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { tags } = parse(z.object({ tags: tagSchema }), body);
    const saved = await this.db.asUser(userId, async (q) => {
      const [r] = await q('select id from resume_files where id = $1', [id]);
      if (!r) throw new NotFoundException();
      const list = await setResumeTags(q, userId, id, tags);
      await audit(q, userId, 'resume.tagged', id, { tags: list });
      return list;
    });
    await this.matching.recompute(userId);
    return { id, tags: saved };
  }

  /**
   * Stores a read-only snapshot. Edits happen in the external Resume Builder; re-upload adds a new
   * version. Optional "tags" form field: comma-separated, e.g. ".NET, Angular".
   */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async upload(
    @UserId() userId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { tags?: string } = {},
  ) {
    const tags = parse(tagSchema, String(body?.tags ?? '').split(',').filter((t) => t.trim()));
    const result = await this.store(userId, file, tags);
    if (tags.length && !result.duplicate) await this.matching.recompute(userId);
    return result;
  }

  private async store(userId: string, file: Express.Multer.File | undefined, tags: string[]) {
    if (!file) throw new BadRequestException('Attach a PDF or DOCX file.');
    const filename = file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 150) || 'resume';
    const mime = detectType(file.buffer, filename);
    if (!mime) throw new BadRequestException('Only PDF and DOCX resumes are supported.');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const text = await extractText(file.buffer, mime);
    return this.db.asUser(userId, async (q) => {
      const [row] = await q(
        `insert into resume_files (user_id, filename, mime_type, size_bytes, sha256, content, extracted_text)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (user_id, sha256) do nothing
         returning id, filename, sha256, uploaded_at`,
        [userId, filename, mime, file.size, sha256, file.buffer, text],
      );
      if (!row) {
        const [existing] = await q('select id, filename, sha256, uploaded_at from resume_files where sha256 = $1', [sha256]);
        return { ...existing, duplicate: true };
      }
      const saved = await setResumeTags(q, userId, row.id, tags);
      await audit(q, userId, 'resume.imported', row.id, { filename, sha256, extracted: text.length > 0, tags: saved });
      return { ...row, duplicate: false, has_text: text.length > 0, tags: saved };
    });
  }

  @Get(':id/file')
  async download(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const [row] = await this.db.asUser(userId, (q) =>
      q('select filename, mime_type, content from resume_files where id = $1', [id]),
    );
    if (!row) throw new NotFoundException();
    res.setHeader('content-type', row.mime_type);
    res.setHeader('content-disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(row.content);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.asUser(userId, async (q) => {
      const rows = await q('delete from resume_files where id = $1 returning id', [id]);
      if (!rows.length) throw new NotFoundException();
      await audit(q, userId, 'resume.deleted', id);
    });
    await this.matching.recompute(userId);
  }
}

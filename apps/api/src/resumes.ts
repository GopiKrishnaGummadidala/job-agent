import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { AuthGuard, UserId } from './auth';
import { audit, Db } from './db';
import { hasTerm } from './matching/score';

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
  matched: string[];
  /** Skills the job mentions and the user's profile lists, but this resume does not mention. */
  missing: string[];
  candidates: { id: string; filename: string; matched: number }[];
}

/** Picks the existing resume that covers the most job-relevant skills. Never modifies a resume. */
export function recommendResume(
  resumes: { id: string; filename: string; extracted_text: string }[],
  terms: string[],
  jobText: string,
): ResumeRecommendation {
  const relevant = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].filter((t) => hasTerm(jobText, t));
  const scored = resumes.map((r) => ({ r, matched: relevant.filter((t) => hasTerm(r.extracted_text, t)) }));
  scored.sort((a, b) => b.matched.length - a.matched.length);
  const best = scored[0];
  return {
    resumeId: best?.r.id ?? null,
    filename: best?.r.filename ?? null,
    matched: best?.matched ?? [],
    missing: best ? relevant.filter((t) => !best.matched.includes(t)) : relevant,
    candidates: scored.map((s) => ({ id: s.r.id, filename: s.r.filename, matched: s.matched.length })),
  };
}

@Controller('me/resumes')
@UseGuards(AuthGuard)
export class ResumesController {
  constructor(private db: Db) {}

  @Get()
  list(@UserId() userId: string) {
    return this.db.asUser(userId, (q) =>
      q(
        `select id, filename, mime_type, size_bytes, sha256, uploaded_at, length(extracted_text) > 0 as has_text,
                left(extracted_text, 600) as preview,
                (select count(*) from application_drafts d where d.resume_id = r.id)::int as used_by
         from resume_files r order by uploaded_at desc`,
      ),
    );
  }

  /** Stores a read-only snapshot. Edits happen in the external Resume Builder; re-upload adds a new version. */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async upload(@UserId() userId: string, @UploadedFile() file: Express.Multer.File | undefined) {
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
      await audit(q, userId, 'resume.imported', row.id, { filename, sha256, extracted: text.length > 0 });
      return { ...row, duplicate: false, has_text: text.length > 0 };
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
  }
}

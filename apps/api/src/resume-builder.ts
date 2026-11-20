import { BadRequestException, Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AuthGuard, parse, UserId } from './auth';
import { audit, Db, type Q } from './db';

export const builderRoot = process.env.RESUME_BUILDER_ROOT
  ? resolve(__dirname, '../../../..', process.env.RESUME_BUILDER_ROOT)
  : null;
export const builderAvailable = !!builderRoot && existsSync(resolve(builderRoot, 'index.html'));
export const builderWorkspace = /^(personal|[a-f0-9-]{36})$/i;

async function workspace(q: Q, actor: string, target: string) {
  const owner = target === 'personal' ? actor : parse(z.uuid(), target);
  const [member] = await q(
    `select u.id, u.email from users u where u.id = $1 and (
      u.id = $2 or exists (select 1 from workspace_delegates d where d.owner_id = u.id and d.delegate_id = $2)
    )`, [owner, actor],
  );
  if (!member) throw new BadRequestException('This workspace is unavailable.');
  return member as { id: string; email: string };
}

const stamp = z.coerce.number().int().min(1).max(8_640_000_000_000_000);
const documentId = z.string().min(1).max(120);

@Controller('me/resume-builder/:workspace')
@UseGuards(AuthGuard)
export class ResumeBuilderController {
  constructor(private db: Db) {}

  @Get('auth/me')
  session(@UserId() actor: string, @Param('workspace') target: string) {
    return this.db.asUser(actor, async (q) => {
      const owner = await workspace(q, actor, target);
      return { user: { id: actor + ':' + owner.id, email: owner.email, delegated: owner.id !== actor } };
    });
  }

  @Get('docs')
  docs(@UserId() actor: string, @Param('workspace') target: string) {
    return this.db.asUser(actor, async (q) => {
      const owner = await workspace(q, actor, target);
      const rows = await q('select id, data, deleted_at from resume_builder_documents where owner_id = $1 order by updated_at desc', [owner.id]);
      return {
        docs: rows.filter((row) => row.data).map((row) => row.data),
        deleted: Object.fromEntries(rows.filter((row) => row.deleted_at).map((row) => [row.id, Number(row.deleted_at)])),
      };
    });
  }

  @Put('docs/:id')
  async save(@UserId() actor: string, @Param('workspace') target: string, @Param('id') value: string, @Body() body: unknown) {
    const id = parse(documentId, value);
    const { doc } = parse(z.object({ doc: z.record(z.string(), z.unknown()) }), body);
    if (!builderRoot) throw new BadRequestException('Resume Builder is unavailable.');
    const { normalizeDoc } = await import(pathToFileURL(resolve(builderRoot, 'js/data.js')).href);
    const normalized = normalizeDoc(doc);
    if (!normalized || normalized.id !== id) throw new BadRequestException('Invalid resume document.');
    const updated = parse(stamp, normalized.updatedAt);
    if (updated > Date.now() + 300_000) throw new BadRequestException('The document timestamp is too far in the future.');
    return this.db.asUser(actor, async (q) => {
      const owner = await workspace(q, actor, target);
      const rows = await q(
        `insert into resume_builder_documents (owner_id, id, data, updated_at) values ($1, $2, $3, $4)
         on conflict (owner_id, id) do update set data = excluded.data, updated_at = excluded.updated_at, deleted_at = null
         where resume_builder_documents.updated_at < excluded.updated_at returning id`, [owner.id, id, normalized, updated],
      );
      if (rows.length) await audit(q, actor, 'resume_builder.saved', owner.id, { document_id: id });
      return { saved: !!rows.length };
    });
  }

  @Delete('docs/:id')
  remove(@UserId() actor: string, @Param('workspace') target: string, @Param('id') value: string, @Query('at') time: unknown) {
    const id = parse(documentId, value);
    const updated = parse(stamp, time);
    if (updated > Date.now() + 300_000) throw new BadRequestException('The document timestamp is too far in the future.');
    return this.db.asUser(actor, async (q) => {
      const owner = await workspace(q, actor, target);
      const rows = await q(
        `insert into resume_builder_documents (owner_id, id, updated_at, deleted_at) values ($1, $2, $3, $3)
         on conflict (owner_id, id) do update set data = null, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
         where resume_builder_documents.updated_at <= excluded.updated_at returning id`, [owner.id, id, updated],
      );
      if (rows.length) await audit(q, actor, 'resume_builder.removed', owner.id, { document_id: id });
      return { deleted: !!rows.length };
    });
  }

  @Get('tailor')
  tailor() {
    return { providers: {} };
  }
}

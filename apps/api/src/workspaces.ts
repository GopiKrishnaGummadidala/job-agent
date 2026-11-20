import { Body, ConflictException, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuthGuard, parse, UserId } from './auth';
import { audit, Db } from './db';
import { builderAvailable } from './resume-builder';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

@Controller('me/workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(private db: Db) {}

  @Get()
  list(@UserId() actor: string) {
    return this.db.asUser(actor, async (q) => ({
      resumeBuilder: builderAvailable,
      shared: await q(`select d.owner_id as id, u.email from workspace_delegates d
        join users u on u.id = d.owner_id where d.delegate_id = $1 order by u.email`, [actor]),
      delegates: await q(`select d.delegate_id as id, u.email from workspace_delegates d
        join users u on u.id = d.delegate_id where d.owner_id = $1 order by u.email`, [actor]),
      invites: await q('select delegate_email as email from workspace_invites where expires_at > now() order by delegate_email'),
    }));
  }

  @Post('invites')
  invite(@UserId() actor: string, @Body() body: unknown) {
    const { email } = parse(z.object({ email: z.email().transform((value) => value.toLowerCase()) }), body);
    const token = randomBytes(32).toString('base64url');
    return this.db.asUser(actor, async (q) => {
      await q(`insert into workspace_invites values ($1, $2, $3, now() + interval '7 days')
        on conflict (owner_id, delegate_email) do update
        set token_hash = excluded.token_hash, expires_at = excluded.expires_at`, [actor, email, hash(token)]);
      await audit(q, actor, 'workspace.invited', null, { email });
      return { token };
    });
  }

  @Post('accept')
  accept(@UserId() actor: string, @Body() body: unknown) {
    const { token } = parse(z.object({ token: z.string().regex(/^[\w-]{43}$/) }), body);
    return this.db.asUser(actor, async (q) => {
      const [result] = await q('select accept_workspace_invite($1) as id', [hash(token)]);
      if (!result.id) throw new ConflictException('Invitation invalid, expired, or intended for another account.');
      await audit(q, actor, 'workspace.accepted', result.id);
      return { id: result.id };
    });
  }

  @Delete('delegates/:id')
  revoke(@UserId() actor: string, @Param('id') value: string) {
    const id = parse(z.uuid(), value);
    return this.db.asUser(actor, async (q) => {
      await q('delete from workspace_delegates where owner_id = $1 and delegate_id = $2', [actor, id]);
      await q('delete from workspace_invites where delegate_email = (select email from users where id = $1)', [id]);
      await audit(q, actor, 'workspace.revoked', id);
    });
  }

  @Delete('invites')
  cancel(@UserId() actor: string, @Body() body: unknown) {
    const { email } = parse(z.object({ email: z.email() }), body);
    return this.db.asUser(actor, (q) => q('delete from workspace_invites where delegate_email = $1', [email]));
  }
}

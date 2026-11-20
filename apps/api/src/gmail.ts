import {
  BadGatewayException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Res, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard, parse, UserId } from './auth';
import { config } from './config';
import { audit, Db } from './db';
import { alertSenders, jobLink, parseAlert, providers } from './gmail-alerts';

const scope = 'https://www.googleapis.com/auth/gmail.modify';
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

function gmailConfig() {
  const { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: secret, GMAIL_REDIRECT_URI: redirectUri,
    GMAIL_TOKEN_KEY: encodedKey } = process.env;
  const key = Buffer.from(encodedKey ?? '', 'base64');
  if (!clientId || !secret || !redirectUri || key.length !== 32) return null;
  return { clientId, secret, redirectUri, key };
}

function seal(token: string, key: Buffer, userId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function unseal(value: string, key: Buffer, userId: string) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

const callbackQuery = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().optional(),
});
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  scope: z.string(),
});

interface MailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: MailPart[];
}

function collectParts(part: MailPart, output: { html: string[]; plain: string[] }) {
  if (part.filename) return;
  if (part.body?.data) {
    const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
    if (part.mimeType === 'text/html') output.html.push(decoded);
    if (part.mimeType === 'text/plain') output.plain.push(decoded);
  }
  for (const child of part.parts ?? []) collectParts(child, output);
}

async function gmailRequest(token: string, path: string, init?: RequestInit) {
  return fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
}

@Controller('me/gmail')
@UseGuards(AuthGuard)
export class GmailController {
  constructor(private db: Db) {}

  @Get()
  async status(@UserId() userId: string) {
    const [connection] = await this.db.asUser(userId, (q) =>
      q('select email, connected_at from gmail_connections'));
    return { configured: Boolean(gmailConfig()), connection: connection ?? null };
  }

  @Get('jobs')
  async jobs(@UserId() userId: string, @Query('provider') value: unknown, @Query('workspace') workspace: unknown) {
    const provider = parse(z.enum(providers).default('linkedin'), value);
    const owner = parse(z.uuid().optional(), workspace) ?? userId;
    const jobs = await this.db.asUser(userId, (q) => q(
      `select j.external_id, j.title, j.received_at, j.status, j.status_at, u.email as status_actor
       from gmail_alert_jobs j left join users u on u.id = j.status_actor_id
       where j.provider = $1 and j.user_id = $2 order by j.received_at desc, j.external_id`,
      [provider, owner],
    ));
    return jobs.map((job) => ({ ...job, url: jobLink(provider, job.external_id) }));
  }

  @Patch('jobs/:id/status')
  setJobStatus(@UserId() userId: string, @Param('id') id: string, @Body() input: unknown) {
    const { provider, status, workspace } = parse(z.object({
      provider: z.enum(providers),
      status: z.enum(['pending', 'viewed', 'applied']),
      workspace: z.uuid().optional(),
    }), input);
    return this.db.asUser(userId, async (q) => {
      const [job] = await q(
        `update gmail_alert_jobs
         set status = case when $3 = 'viewed' and status = 'applied' then status else $3 end,
             status_actor_id = case when status = $3 or ($3 = 'viewed' and status = 'applied') then status_actor_id else $5 end,
             status_at = case when status = $3 or ($3 = 'viewed' and status = 'applied') then status_at else now() end
         where provider = $1 and external_id = $2 and user_id = $4 returning status`,
        [provider, id, status, workspace ?? userId, userId],
      );
      if (!job) throw new NotFoundException('Imported job not found.');
      return job;
    });
  }

  @Post('jobs/import')
  async importJobs(@UserId() userId: string, @Query('provider') value: unknown) {
    const provider = parse(z.enum(providers).default('linkedin'), value);
    const settings = gmailConfig();
    if (!settings) throw new ServiceUnavailableException('Gmail setup is incomplete.');
    const [connection] = await this.db.asUser(userId, (q) => q('select encrypted_refresh_token from gmail_connections'));
    if (!connection) throw new ConflictException('Connect Gmail first.');

    const summary = { alertsSaved: 0, jobsAdded: 0, unreadRetained: 0 };
    try {
      const exchange = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: settings.clientId,
          client_secret: settings.secret,
          grant_type: 'refresh_token',
          refresh_token: unseal(connection.encrypted_refresh_token, settings.key, userId),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!exchange.ok) throw new BadGatewayException('Gmail could not renew access. Check your connection in Settings.');
      const { access_token: token } = z.object({ access_token: z.string().min(1) }).parse(await exchange.json());
      const query = new URLSearchParams({
        q: 'is:unread ' + alertSenders[provider],
        maxResults: '100',
      });
      do {
        const listing = await gmailRequest(token, `messages?${query}`);
        if (!listing.ok) throw new BadGatewayException('Gmail could not list unread alerts.');
        const page = z.object({
          messages: z.array(z.object({ id: z.string() })).default([]),
          nextPageToken: z.string().optional(),
        }).parse(await listing.json());
        // Keep the unread search result stable while collecting all pages.
        for (const message of page.messages) {
          const id = encodeURIComponent(message.id);
          try {
            const detail = await gmailRequest(token, `messages/${id}?format=full`);
            if (!detail.ok) throw new Error();
            const data = await detail.json() as { internalDate: string; payload?: MailPart };
            const parts = { html: [] as string[], plain: [] as string[] };
            if (data.payload) collectParts(data.payload, parts);
            const jobs = parseAlert(parts.html.join('\n'), parts.plain.join('\n'), provider);
            if (!jobs.length) {
              summary.unreadRetained++;
              continue;
            }
            const receivedAt = new Date(Number(data.internalDate)).toISOString();
            const added = await this.db.asUser(userId, async (q) => {
              let count = 0;
              for (const job of jobs) {
                const inserted = await q(
                  `insert into gmail_alert_jobs (user_id, external_id, title, received_at, provider)
                   values ($1, $2, $3, $4, $5) on conflict (user_id, provider, external_id) do nothing returning external_id`,
                  [userId, job.externalId, job.title, receivedAt, provider],
                );
                count += inserted.length;
                if (!inserted.length && job.title) {
                  await q('update gmail_alert_jobs set title = $2 where external_id = $1 and provider = $3 and user_id = $4 and title is null',
                    [job.externalId, job.title, provider, userId]);
                }
              }
              return count;
            });
            summary.alertsSaved++;
            summary.jobsAdded += added;
            // Link parsing cannot prove the alert contained no additional recommendations.
            summary.unreadRetained++;
          } catch {
            summary.unreadRetained++;
          }
        }
        if (!page.nextPageToken) break;
        query.set('pageToken', page.nextPageToken);
      } while (true);
      return summary;
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException('Gmail import was interrupted. Run it again to retry.');
    }
  }

  @Post('connect')
  async connect(@UserId() userId: string) {
    const settings = gmailConfig();
    if (!settings) throw new ServiceUnavailableException('Gmail setup is incomplete.');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await this.db.asUser(userId, async (q) => {
      await q('delete from gmail_oauth_attempts');
      await q(
        "insert into gmail_oauth_attempts values ($1, $2, $3, now() + interval '10 minutes')",
        [sha256(state), userId, verifier],
      );
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: 'code',
      scope, state, access_type: 'offline', prompt: 'consent', code_challenge: sha256(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString() };
  }

  @Get('callback')
  async callback(@UserId() userId: string, @Query() query: unknown, @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const returnUrl = new URL('/settings', config.webOrigin);
    const finish = (result: string) => {
      returnUrl.searchParams.set('gmail', result);
      return response.redirect(303, returnUrl.toString());
    };
    const settings = gmailConfig();
    const parsed = callbackQuery.safeParse(query);
    if (!settings || !parsed.success) return finish('failed');
    const [attempt] = await this.db.asUser(userId, (q) =>
      q('delete from gmail_oauth_attempts where state_hash = $1 and expires_at > now() returning verifier',
        [sha256(parsed.data.state)]));
    if (!attempt || parsed.data.error || !parsed.data.code) return finish('failed');

    try {
      const exchange = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          code: parsed.data.code, client_id: settings.clientId, client_secret: settings.secret,
          redirect_uri: settings.redirectUri, grant_type: 'authorization_code', code_verifier: attempt.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!exchange.ok) return finish('failed');
      const tokens = tokenResponse.parse(await exchange.json());
      if (!tokens.scope.split(/\s+/).includes(scope)) return finish('failed');
      const mailbox = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!mailbox.ok) return finish('failed');
      const { emailAddress } = z.object({ emailAddress: z.email() }).parse(await mailbox.json());
      await this.db.asUser(userId, async (q) => {
        await q('delete from gmail_connections');
        await q('insert into gmail_connections (user_id, email, encrypted_refresh_token) values ($1, $2, $3)',
          [userId, emailAddress, seal(tokens.refresh_token, settings.key, userId)]);
        await audit(q, userId, 'gmail.connected', null);
      });
      return finish('connected');
    } catch {
      return finish('failed');
    }
  }

  @Delete()
  async disconnect(@UserId() userId: string) {
    const settings = gmailConfig();
    if (!settings) throw new ServiceUnavailableException('Gmail setup is incomplete.');
    const [connection] = await this.db.asUser(userId, (q) => q('select encrypted_refresh_token from gmail_connections'));
    if (!connection) return { disconnected: true };
    try {
      const result = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        body: new URLSearchParams({ token: unseal(connection.encrypted_refresh_token, settings.key, userId) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok) {
        const body = z.object({ error: z.string() }).safeParse(await result.json());
        if (result.status !== 400 || !body.success || body.data.error !== 'invalid_token') throw new Error();
      }
    } catch {
      throw new BadGatewayException('Google could not disconnect Gmail. Try again.');
    }
    await this.db.asUser(userId, async (q) => {
      await q('delete from gmail_connections where encrypted_refresh_token = $1', [connection.encrypted_refresh_token]);
      await q('delete from gmail_oauth_attempts');
      await audit(q, userId, 'gmail.disconnected', null);
    });
    return { disconnected: true };
  }
}

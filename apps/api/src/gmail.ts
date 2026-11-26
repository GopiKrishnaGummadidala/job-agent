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
import { companyFromSender, responseOutcome, senderAddress, workableInterview } from './interview-responses';

const scope = 'https://www.googleapis.com/auth/gmail.modify';
const trackedProviders = [...providers, 'manual'] as const;
const manualJobInput = z.object({
  workspace: z.uuid().optional(),
  url: z.string().trim().max(2048).pipe(z.url({ protocol: /^https?$/ })).transform((value) => new URL(value))
    .refine((url) => !url.username && !url.password, 'Use a link without embedded credentials.')
    .transform((url) => url.href),
  title: z.string().trim().min(1).max(250),
  company: z.string().trim().max(150).optional(),
});
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const responseSearch = [
  'subject:interview', 'subject:Einladung', 'subject:Vorstellungsgespräch', 'subject:Kennenlerngespräch',
  'subject:Bewerbung', 'subject:Absage', 'subject:"your application"', 'subject:"application update"',
  'subject:"next steps"', 'subject:"job offer"',
  'from:4f54m_ff28rt@inbound.workablemail.com',
].join(' ');
const interviewFields = z.object({
  company: z.string().trim().max(200),
  job_title: z.string().trim().max(250),
  stage: z.enum(['unknown', 'screen', 'first', 'second', 'final']),
  outcome: z.enum(['review', 'positive', 'scheduled', 'rejected', 'offer', 'unrelated']),
});

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
    const provider = parse(z.enum(trackedProviders).default('linkedin'), value);
    const owner = parse(z.uuid().optional(), workspace) ?? userId;
    const jobs = await this.db.asUser(userId, (q) => q(
      `select j.external_id, j.title, j.company, j.received_at, j.status, j.status_at, j.manual_url, u.email as status_actor,
         coalesce((select jsonb_agg(jsonb_build_object('email', viewer.email, 'viewed_at', v.viewed_at)
                                   order by v.viewed_at desc, v.viewer_id)
                   from gmail_job_views v join users viewer on viewer.id = v.viewer_id
                   where (v.user_id, v.provider, v.external_id) = (j.user_id, j.provider, j.external_id)),
                  '[]'::jsonb) as viewers
       from gmail_alert_jobs j left join users u on u.id = j.status_actor_id
       where j.provider = $1 and j.user_id = $2 order by j.received_at desc, j.external_id`,
      [provider, owner],
    ));
    return jobs.map(({ manual_url, ...job }) => ({
      ...job,
      url: provider === 'manual' ? manual_url : jobLink(provider, job.external_id),
    }));
  }

  @Post('jobs/manual')
  async addManualJob(@UserId() userId: string, @Body() input: unknown) {
    const { workspace, url, title, company } = parse(manualJobInput, input);
    const owner = workspace ?? userId;
    const [job] = await this.db.asUser(userId, async (q) => {
      if (owner !== userId) {
        const [access] = await q('select 1 from workspace_delegates where owner_id = $1 and delegate_id = $2', [owner, userId]);
        if (!access) throw new NotFoundException('Workspace not found.');
      }
      return q(
        `insert into gmail_alert_jobs (user_id, provider, external_id, title, company, received_at, manual_url)
         values ($1, 'manual', gen_random_uuid()::text, $2, $3, now(), $4)
         on conflict (user_id, manual_url) where provider = 'manual' do nothing
         returning external_id`,
        [owner, title, company || null, url],
      );
    });
    if (!job) throw new ConflictException('This job link is already saved.');
    return job;
  }

  @Patch('jobs/manual/:id')
  async editManualJob(@UserId() userId: string, @Param('id') id: string, @Body() input: unknown) {
    const { workspace, url, title, company } = parse(manualJobInput, input);
    try {
      const [job] = await this.db.asUser(userId, (q) => q(
        `update gmail_alert_jobs set title = $3, company = $4, manual_url = $5
         where user_id = $1 and provider = 'manual' and external_id = $2 returning external_id`,
        [workspace ?? userId, id, title, company || null, url],
      ));
      if (!job) throw new NotFoundException('Saved job not found.');
      return job;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('This job link is already saved.');
      throw error;
    }
  }

  @Get('jobs/activity')
  async activity(@UserId() userId: string, @Query('workspace') workspace: unknown) {
    const owner = parse(z.uuid().optional(), workspace) ?? userId;
    return this.db.asUser(userId, async (q) => {
      const totals = await q(
        'select status, count(*)::int as count from gmail_alert_jobs where user_id = $1 group by status',
        [owner],
      );
      const daily = await q(
        `with calendar as (
           select (now() at time zone 'Europe/Berlin')::date - offset_days as day
           from generate_series(0, 13) as offsets(offset_days)
         ), applications as (
           select (status_at at time zone 'Europe/Berlin')::date as day, count(*)::int as count
           from gmail_alert_jobs
           where user_id = $1 and status = 'applied'
             and status_at >= ((select min(day) from calendar)::timestamp at time zone 'Europe/Berlin')
           group by 1
         )
         select calendar.day::text as day, coalesce(applications.count, 0) as count
         from calendar left join applications using (day)
         order by calendar.day`,
        [owner],
      );
      return { totals, daily };
    });
  }

  @Patch('jobs/:id/status')
  setJobStatus(@UserId() userId: string, @Param('id') id: string, @Body() input: unknown) {
    const { provider, status, workspace } = parse(z.object({
      provider: z.enum(trackedProviders),
      status: z.enum(['pending', 'viewed', 'applied', 'unfit']),
      workspace: z.uuid().optional(),
    }), input);
    return this.db.asUser(userId, async (q) => {
      const [job] = await q(
        `update gmail_alert_jobs
         set status = case when $3 = 'viewed' and status in ('applied', 'unfit') then status else $3 end,
             status_actor_id = case when status = $3 or ($3 = 'viewed' and status in ('applied', 'unfit')) then status_actor_id else $5 end,
             status_at = case when status = $3 or ($3 = 'viewed' and status in ('applied', 'unfit')) then status_at else now() end
         where provider = $1 and external_id = $2 and user_id = $4 returning status`,
        [provider, id, status, workspace ?? userId, userId],
      );
      if (!job) throw new NotFoundException('Imported job not found.');
      if (status === 'viewed') {
        await q(
          `insert into gmail_job_views (user_id, provider, external_id, viewer_id)
           values ($1, $2, $3, $4)
           on conflict (user_id, provider, external_id, viewer_id)
           do update set viewed_at = greatest(gmail_job_views.viewed_at, excluded.viewed_at)`,
          [workspace ?? userId, provider, id, userId],
        );
      }
      return job;
    });
  }

  private async mailbox(userId: string) {
    const settings = gmailConfig();
    if (!settings) throw new ServiceUnavailableException('Gmail setup is incomplete.');
    const [connection] = await this.db.asUser(userId, (q) => q('select encrypted_refresh_token from gmail_connections'));
    if (!connection) throw new ConflictException('Connect Gmail first.');

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
      return token;
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException('Gmail could not renew access. Check your connection in Settings.');
    }
  }

  @Get('interviews')
  async interviews(@UserId() userId: string) {
    const rows = await this.db.asUser(userId, (q) => q(
      `select message_id, subject, sender, received_at, company, job_title, stage, outcome
       from private_interviews where user_id = $1 order by received_at desc, message_id`, [userId],
    ));
    const workableCompanies = new Map<string, Set<string>>();
    for (const row of rows) {
      const address = senderAddress(row.sender);
      if (!address.endsWith('@inbound.workablemail.com')) continue;
      const company = workableInterview(row.subject)?.company;
      if (!company) continue;
      const names = workableCompanies.get(address) ?? new Set<string>();
      names.add(company);
      workableCompanies.set(address, names);
    }
    return rows.map((row) => {
      const address = senderAddress(row.sender);
      const details = address.endsWith('@inbound.workablemail.com') ? workableInterview(row.subject) : null;
      const names = workableCompanies.get(address);
      const originalName = row.sender.match(/^(.+?)\s*<[^>]+>$/)?.[1].replace(/^"|"$/g, '').slice(0, 200);
      const inferredCompany = details?.company ?? (names?.size === 1 ? [...names][0] : undefined);
      const canInfer = !row.company || row.company === originalName || row.company === companyFromSender(row.sender);
      return {
        ...row,
        company: canInfer ? inferredCompany ?? row.company : row.company,
        job_title: row.job_title || details?.jobTitle || '',
        outcome: responseOutcome(row.subject) === 'unrelated'
          ? 'unrelated'
          : row.outcome === 'review' ? responseOutcome(row.subject) : row.outcome,
      };
    });
  }

  @Patch('interviews/:id')
  async updateInterview(@UserId() userId: string, @Param('id') id: string, @Body() input: unknown) {
    const { company, job_title, stage, outcome } = parse(interviewFields, input);
    const [row] = await this.db.asUser(userId, (q) => q(
      `update private_interviews set company = $3, job_title = $4, stage = $5, outcome = $6
       where user_id = $1 and message_id = $2 returning message_id`,
      [userId, id, company, job_title, stage, outcome],
    ));
    if (!row) throw new NotFoundException('Interview response not found.');
    return row;
  }

  @Post('interviews/import')
  async importInterviews(@UserId() userId: string, @Body() input: unknown) {
    const { cursor } = parse(z.object({ cursor: z.string().max(4096).optional() }), input ?? {});
    const token = await this.mailbox(userId);
    const query = new URLSearchParams({
      q: '-in:sent -in:drafts {' + responseSearch + '}',
      maxResults: '20',
      ...(cursor ? { pageToken: cursor } : {}),
    });
    try {
      const listing = await gmailRequest(token, 'messages?' + query);
      if (!listing.ok) throw new Error('Cannot list messages');
      const page = z.object({
        messages: z.array(z.object({ id: z.string().regex(/^[a-z0-9]+$/i) })).default([]),
        nextPageToken: z.string().optional(),
      }).parse(await listing.json());
      const messages = await Promise.all(page.messages.map(async ({ id }) => {
        const detail = await gmailRequest(token, 'messages/' + id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From');
        if (detail.status === 404) return null;
        if (!detail.ok) throw new Error('Cannot read message headers');
        const result = z.object({
          internalDate: z.coerce.number(),
          snippet: z.string().optional(),
          payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) }).optional(),
        }).safeParse(await detail.json());
        if (!result.success || !result.data.payload || !Number.isFinite(new Date(result.data.internalDate).valueOf())) return null;
        const { payload, snippet, internalDate } = result.data;
        const header = (name: string) => payload.headers.find((h) => h.name.toLowerCase() === name)?.value.trim().slice(0, 500) ?? '';
        const sender = header('from');
        const company = companyFromSender(sender);
        const subject = header('subject');
        const outcome = responseOutcome(subject, snippet);
        if (outcome === 'unrelated') return null;
        const jobTitle = subject.match(/\b(?:your application for|ihre bewerbung als)\s+(.+)$/iu)?.[1].slice(0, 250) ?? '';
        return { id, sender, company, subject, jobTitle, outcome, date: new Date(internalDate).toISOString() };
      }));
      const added = await this.db.asUser(userId, async (q) => {
        let count = 0;
        for (const msg of messages) {
          if (!msg) continue;
          const rows = await q(
            `insert into private_interviews (user_id, message_id, subject, sender, received_at, company, job_title, outcome)
             values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing returning message_id`,
            [userId, msg.id, msg.subject, msg.sender, msg.date, msg.company, msg.jobTitle, msg.outcome],
          );
          count += rows.length;
          if (!rows.length && msg.outcome !== 'review') {
            await q(
              `update private_interviews set outcome = $3
               where user_id = $1 and message_id = $2 and outcome = 'review' and stage = 'unknown'`,
              [userId, msg.id, msg.outcome],
            );
          }
        }
        return count;
      });
      return { added, next: page.nextPageToken ?? null };
    } catch {
      throw new BadGatewayException('Could not import interview responses. Try importing again.');
    }
  }

  @Post('jobs/import')
  async importJobs(@UserId() userId: string, @Query('provider') value: unknown, @Query('includeRead') includeRead: unknown) {
    const provider = parse(z.enum(providers).default('linkedin'), value);
    const scanRecent = provider === 'indeed' && includeRead === 'true';
    const token = await this.mailbox(userId);
    const summary = { alertsSaved: 0, jobsAdded: 0, unreadRetained: 0, markedRead: 0 };
    const savedMessages = new Set<string>();
    try {
      const query = new URLSearchParams({
        q: (scanRecent ? 'newer_than:30d ' : 'is:unread ') + alertSenders[provider],
        maxResults: '100',
      });
      do {
        const listing = await gmailRequest(token, `messages?${query}`);
        if (!listing.ok) throw new BadGatewayException('Gmail could not list job alerts.');
        const page = z.object({
          messages: z.array(z.object({ id: z.string() })).default([]),
          nextPageToken: z.string().optional(),
        }).parse(await listing.json());
        // Keep the unread search result stable while collecting all pages.
        for (const message of page.messages) {
          const id = encodeURIComponent(message.id);
          let unread = !scanRecent;
          try {
            const detail = await gmailRequest(token, `messages/${id}?format=full`);
            if (!detail.ok) throw new Error();
            const data = await detail.json() as { internalDate: string; labelIds?: string[]; payload?: MailPart };
            unread ||= data.labelIds?.includes('UNREAD') === true;
            const parts = { html: [] as string[], plain: [] as string[] };
            if (data.payload) collectParts(data.payload, parts);
            const jobs = parseAlert(parts.html.join('\n'), parts.plain.join('\n'), provider);
            if (!jobs.length) {
              if (unread) summary.unreadRetained++;
              continue;
            }
            const receivedAt = new Date(Number(data.internalDate)).toISOString();
            const added = await this.db.asUser(userId, async (q) => {
              let count = 0;
              for (const job of jobs) {
                const inserted = await q(
                  `insert into gmail_alert_jobs (user_id, external_id, title, received_at, provider, company)
                   values ($1, $2, $3, $4, $5, $6) on conflict (user_id, provider, external_id) do nothing returning external_id`,
                  [userId, job.externalId, job.title, receivedAt, provider, job.company ?? null],
                );
                count += inserted.length;
                if (!inserted.length && (job.title || job.company)) {
                  await q(`update gmail_alert_jobs set title = coalesce(title, $2), company = coalesce(company, $5)
                    where external_id = $1 and provider = $3 and user_id = $4
                    and (title is null or company is null)`,
                    [job.externalId, job.title, provider, userId, job.company ?? null]);
                }
              }
              return count;
            });
            summary.alertsSaved++;
            summary.jobsAdded += added;
            if (unread) savedMessages.add(id);
          } catch {
            if (unread) summary.unreadRetained++;
          }
        }
        if (!page.nextPageToken) break;
        query.set('pageToken', page.nextPageToken);
      } while (true);
      // Changing labels during pagination can remove messages from later search pages.
      for (const id of savedMessages) {
        try {
          const result = await gmailRequest(token, `messages/${id}/modify`, {
            method: 'POST',
            body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
          });
          if (result.ok) summary.markedRead++;
          else summary.unreadRetained++;
        } catch {
          summary.unreadRetained++;
        }
      }
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

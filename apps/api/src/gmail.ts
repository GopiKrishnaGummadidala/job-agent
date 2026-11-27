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
const calendarScope = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
const calendarEvent = z.object({
  id: z.string().min(1).max(1024),
  summary: z.string().default('Calendar meeting'),
  start: z.object({ dateTime: z.iso.datetime({ offset: true }).optional() }).optional(),
  status: z.string().optional(),
  attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
  htmlLink: z.url({ protocol: /^https$/ }).optional(),
  hangoutLink: z.url({ protocol: /^https$/ }).optional(),
  conferenceData: z.object({ entryPoints: z.array(z.object({ entryPointType: z.string(), uri: z.string() })).optional() }).optional(),
});

function meeting(event: z.infer<typeof calendarEvent>) {
  if (!event.start?.dateTime || event.status === 'cancelled'
    || event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined')) return null;
  const link = event.hangoutLink ?? event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri;
  return {
    event_id: event.id, title: event.summary.slice(0, 300), starts_at: event.start.dateTime,
    calendar_url: event.htmlLink ?? null,
    meeting_url: z.url({ protocol: /^https$/ }).safeParse(link).data ?? null,
  };
}
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
      `select j.external_id, j.title, j.company, j.received_at, j.status, j.status_at, j.manual_url, j.source_url, u.email as status_actor,
         coalesce((select jsonb_agg(jsonb_build_object('email', viewer.email, 'viewed_at', v.viewed_at)
                                   order by v.viewed_at desc, v.viewer_id)
                   from gmail_job_views v join users viewer on viewer.id = v.viewer_id
                   where (v.user_id, v.provider, v.external_id) = (j.user_id, j.provider, j.external_id)),
                  '[]'::jsonb) as viewers
       from gmail_alert_jobs j left join users u on u.id = j.status_actor_id
       where j.provider = $1 and j.user_id = $2 order by j.received_at desc, j.external_id`,
      [provider, owner],
    ));
    return jobs.map(({ manual_url, source_url, ...job }) => ({
      ...job,
      url: provider === 'manual' ? manual_url : source_url ?? jobLink(provider, job.external_id),
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
      status: z.enum(['pending', 'viewed', 'applied', 'interviewed', 'unfit']),
      workspace: z.uuid().optional(),
    }), input);
    return this.db.asUser(userId, async (q) => {
      const [job] = await q(
        `update gmail_alert_jobs
         set status = case when $3 = 'viewed' and status in ('applied', 'interviewed', 'unfit') then status else $3 end,
             status_actor_id = case when status = $3 or ($3 = 'viewed' and status in ('applied', 'interviewed', 'unfit')) then status_actor_id else $5 end,
             status_at = case when status = $3 or ($3 = 'viewed' and status in ('applied', 'interviewed', 'unfit')) then status_at else now() end
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

  private async mailbox(userId: string, purpose: 'gmail' | 'calendar' = 'gmail') {
    const settings = gmailConfig();
    if (!settings) throw new ServiceUnavailableException('Gmail setup is incomplete.');
    const [connection] = await this.db.asUser(userId, (q) => q(purpose === 'gmail'
      ? 'select email as mailbox, encrypted_refresh_token from gmail_connections'
      : 'select null as mailbox, encrypted_refresh_token from private_calendar_connections'));
    if (!connection) throw new ConflictException(purpose === 'gmail' ? 'Connect Gmail first.' : 'Connect Google Calendar first.');

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
      if (!exchange.ok) throw new Error('Token renewal failed');
      const { access_token: token } = z.object({ access_token: z.string().min(1) }).parse(await exchange.json());
      return { token, mailbox: connection.mailbox as string | null };
    } catch (error) {
      throw new BadGatewayException(purpose === 'gmail'
        ? 'Gmail could not renew access. Check your connection in Settings.'
        : 'Google Calendar could not renew access. Reconnect Google Calendar.');
    }
  }

  @Get('calendar/interviews')
  async calendarInterviews(@UserId() userId: string) {
    return this.db.asUser(userId, async (q) => ({
      connected: (await q('select 1 from private_calendar_connections where user_id = $1', [userId])).length > 0,
      meetings: await q(
        `select event_id, title, starts_at, calendar_url, meeting_url, company, job_title
         from private_calendar_interviews where user_id = $1 order by starts_at`, [userId],
      ),
    }));
  }

  private async calendarRequest(token: string, path: string) {
    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events' + path, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (response?.status === 404) throw new NotFoundException('Calendar meeting no longer exists.');
    if (response?.status === 403) throw new ServiceUnavailableException('Enable the Google Calendar API and check the Calendar permission.');
    if (!response?.ok) throw new BadGatewayException('Google Calendar could not load meetings.');
    return response.json();
  }

  @Get('calendar/upcoming')
  async upcomingInterviews(@UserId() userId: string) {
    const { token } = await this.mailbox(userId, 'calendar');
    const now = new Date();
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 90 * 86400_000).toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      fields: 'nextPageToken,items(id,summary,start,status,attendees(self,responseStatus),htmlLink,hangoutLink,conferenceData(entryPoints(entryPointType,uri)))',
    });
    const candidates = [];
    do {
      const page = z.object({ nextPageToken: z.string().optional(), items: z.array(calendarEvent).default([]) })
        .parse(await this.calendarRequest(token, '?' + params));
      for (const event of page.items) {
        const item = meeting(event);
        if (item) candidates.push(item);
      }
      if (!page.nextPageToken) break;
      params.set('pageToken', page.nextPageToken);
    } while (true);
    return candidates;
  }

  @Post('calendar/interviews')
  async confirmCalendarInterview(@UserId() userId: string, @Body() input: unknown) {
    const { event_id, company, job_title } = parse(z.object({
      event_id: z.string().max(1024).regex(/^[A-Za-z0-9_-]+$/),
      company: z.string().trim().min(1).max(200),
      job_title: z.string().trim().min(1).max(250),
    }), input);
    const { token } = await this.mailbox(userId, 'calendar');
    const item = meeting(calendarEvent.parse(await this.calendarRequest(token, '/' + encodeURIComponent(event_id))));
    if (!item) throw new ConflictException('Choose a scheduled calendar meeting.');
    await this.db.asUser(userId, (q) => q(
      `insert into private_calendar_interviews (user_id,event_id,title,starts_at,calendar_url,meeting_url,company,job_title)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (user_id,event_id) do update
       set title=excluded.title, starts_at=excluded.starts_at, calendar_url=excluded.calendar_url,
         meeting_url=excluded.meeting_url, company=excluded.company, job_title=excluded.job_title`,
      [userId, item.event_id, item.title, item.starts_at, item.calendar_url, item.meeting_url, company, job_title],
    ));
    return { saved: true };
  }

  @Delete('calendar/interviews/:id')
  async removeCalendarInterview(@UserId() userId: string, @Param('id') id: string) {
    await this.db.asUser(userId, (q) => q('delete from private_calendar_interviews where user_id = $1 and event_id = $2', [userId, id]));
    return { removed: true };
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
    const { token } = await this.mailbox(userId);
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
  async importJobs(@UserId() userId: string, @Query('provider') value: unknown,
    @Query('includeRead') includeRead: unknown, @Query('markRead') markRead: unknown,
    @Query('incremental') incremental: unknown) {
    const provider = parse(z.enum(providers).default('linkedin'), value);
    const scanIncremental = incremental === 'true';
    const scanRecent = scanIncremental || includeRead === 'true';
    const { token, mailbox } = await this.mailbox(userId);
    if (!mailbox) throw new ConflictException('Reconnect your Gmail account first.');
    const updateLabels = markRead === 'true';
    const summary = { alertsSaved: 0, jobsAdded: 0, unreadRetained: 0, markedRead: 0, alreadyProcessed: 0,
      failed: 0, checkpointAdvanced: false };
    const savedMessages = new Set<string>();
    try {
      const cutoff = Math.floor(Date.now() / 1000);
      let window = scanRecent ? 'newer_than:30d' : 'is:unread';
      if (scanIncremental) {
        const [previous] = await this.db.asUser(userId, (q) => q(
          'select scanned_through from gmail_discovery_windows where user_id = $1 and mailbox = $2 and provider = $3',
          [userId, mailbox, provider],
        ));
        const last = previous ? Math.floor(new Date(previous.scanned_through).getTime() / 1000) : cutoff - 30 * 86400;
        window = `after:${last - 300} before:${cutoff}`;
      }
      const query = new URLSearchParams({
        q: window + ' ' + alertSenders[provider],
        maxResults: '100',
      });
      do {
        const listing = await gmailRequest(token, `messages?${query}`);
        if (!listing.ok) throw new BadGatewayException('Gmail could not list job alerts.');
        const page = z.object({
          messages: z.array(z.object({ id: z.string() })).default([]),
          nextPageToken: z.string().optional(),
        }).parse(await listing.json());
        const processed = new Set((await this.db.asUser(userId, (q) => q(
          `select message_id from gmail_processed_job_alerts
           where user_id = $1 and mailbox = $2 and provider = $3 and message_id = any($4::text[])`,
          [userId, mailbox, provider, page.messages.map(({ id }) => id)],
        ))).map(({ message_id }) => message_id));
        // Keep the unread search result stable while collecting all pages.
        for (const message of page.messages) {
          const id = encodeURIComponent(message.id);
          if (processed.has(message.id)) {
            summary.alreadyProcessed++;
            if (updateLabels && !scanRecent) savedMessages.add(id);
            if (!scanRecent || !updateLabels) continue;
          }
          let unread = !scanRecent;
          try {
            const detail = await gmailRequest(token, `messages/${id}?format=full`);
            if (detail.status === 404 || detail.status === 410) continue;
            if (!detail.ok) throw new Error();
            const data = await detail.json() as {
              internalDate: string; labelIds?: string[];
              payload?: MailPart & { headers?: { name: string; value: string }[] };
            };
            unread ||= data.labelIds?.includes('UNREAD') === true;
            if (processed.has(message.id)) {
              if (unread) savedMessages.add(id);
              continue;
            }
            const parts = { html: [] as string[], plain: [] as string[] };
            if (data.payload) collectParts(data.payload, parts);
            const subject = data.payload?.headers?.find((header) => header.name.toLowerCase() === 'subject')?.value;
            const jobs = parseAlert(parts.html.join('\n'), parts.plain.join('\n'), provider, subject);
            if (!jobs.length) {
              if (unread) summary.unreadRetained++;
              continue;
            }
            const receivedAt = new Date(Number(data.internalDate)).toISOString();
            const added = await this.db.asUser(userId, async (q) => {
              const claim = await q(
                `insert into gmail_processed_job_alerts (user_id, mailbox, provider, message_id)
                 values ($1, $2, $3, $4) on conflict do nothing returning message_id`,
                [userId, mailbox, provider, message.id],
              );
              if (!claim.length) return null;
              let count = 0;
              for (const job of jobs) {
                const inserted = await q(
                  `insert into gmail_alert_jobs (user_id, external_id, title, received_at, provider, company, source_url)
                   values ($1, $2, $3, $4, $5, $6, $7) on conflict (user_id, provider, external_id) do nothing returning external_id`,
                  [userId, job.externalId, job.title, receivedAt, provider, job.company ?? null,
                    job.url === jobLink(provider, job.externalId) ? null : job.url],
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
            if (added === null) summary.alreadyProcessed++;
            else {
              summary.alertsSaved++;
              summary.jobsAdded += added;
            }
            if (updateLabels && unread) savedMessages.add(id);
          } catch {
            summary.failed++;
            if (unread) summary.unreadRetained++;
          }
        }
        if (!page.nextPageToken) break;
        query.set('pageToken', page.nextPageToken);
      } while (true);
      if (scanIncremental && !summary.failed) {
        await this.db.asUser(userId, (q) => q(
          `insert into gmail_discovery_windows (user_id, mailbox, provider, scanned_through)
           values ($1, $2, $3, to_timestamp($4))
           on conflict (user_id, mailbox, provider) do update
           set scanned_through = greatest(gmail_discovery_windows.scanned_through, excluded.scanned_through)`,
          [userId, mailbox, provider, cutoff],
        ));
        summary.checkpointAdvanced = true;
      }
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
  async connect(@UserId() userId: string, @Query('purpose') value: unknown) {
    const purpose = parse(z.enum(['gmail', 'calendar']).default('gmail'), value);
    const settings = gmailConfig();
    if (!settings) throw new ServiceUnavailableException('Gmail setup is incomplete.');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await this.db.asUser(userId, async (q) => {
      await q('delete from gmail_oauth_attempts where purpose = $1 or expires_at <= now()', [purpose]);
      await q(
        "insert into gmail_oauth_attempts (state_hash,user_id,verifier,expires_at,purpose) values ($1, $2, $3, now() + interval '10 minutes', $4)",
        [sha256(state), userId, verifier, purpose],
      );
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: 'code',
      scope: purpose === 'calendar' ? calendarScope : scope, state, access_type: 'offline', prompt: 'consent', code_challenge: sha256(verifier),
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
      returnUrl.searchParams.set(returnUrl.pathname === '/interviews' ? 'calendar' : 'gmail', result);
      return response.redirect(303, returnUrl.toString());
    };
    const settings = gmailConfig();
    const parsed = callbackQuery.safeParse(query);
    if (!settings || !parsed.success) return finish('failed');
    const [attempt] = await this.db.asUser(userId, (q) =>
      q('delete from gmail_oauth_attempts where state_hash = $1 and expires_at > now() returning verifier, purpose',
        [sha256(parsed.data.state)]));
    if (attempt?.purpose === 'calendar') returnUrl.pathname = '/interviews';
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
      if (attempt.purpose === 'calendar') {
        if (!tokens.scope.split(/\s+/).includes(calendarScope)) return finish('failed');
        await this.db.asUser(userId, (q) => q(
          `insert into private_calendar_connections (user_id, encrypted_refresh_token) values ($1, $2)
           on conflict (user_id) do update set encrypted_refresh_token = excluded.encrypted_refresh_token`,
          [userId, seal(tokens.refresh_token, settings.key, userId)],
        ));
        return finish('connected');
      }
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

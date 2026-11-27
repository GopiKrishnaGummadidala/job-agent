import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, parse, UserId } from '../auth';
import { JobAssessmentService } from '../ai/job-assessment.service';
import { config } from '../config';
import { audit, Db } from '../db';
import { MatchingService } from '../matching/matching.service';
import { BOARD_KINDS, BoardKind, boardRefHelp, parseBoardRef } from './adapters';
import { boardHomeCountry, jobCountries } from './countries';
import { boardProviders, type JobDiscoveryProvider } from './discovery-provider';

const MIN_RESYNC_MINUTES = 15;
type RefreshClaim = { id: string; attempts: number };

@Injectable()
export class SourcesService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Sources');
  private timer?: NodeJS.Timeout;
  private schedulerRunning = false;
  private queueRunning = false;

  constructor(
    private db: Db,
    private matching: MatchingService,
    private assessment: JobAssessmentService,
  ) {}

  onModuleInit() {
    if (config.scheduler) {
      void this.backfillCountries();
      void this.refreshDue();
    }
    void this.processRefreshQueue();
    this.timer = setInterval(() => {
      void this.processRefreshQueue();
      if (config.scheduler) void this.refreshDue();
    }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async processRefreshQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    try {
      for (let i = 0; i < 5; i++) {
        const [request] = await this.db.query('select * from claim_board_refresh()');
        if (!request) break;
        let succeeded = false;
        try {
          const result = await this.syncBoard(request.board_id, true, request);
          if (!result.skipped) {
            for (const subscriber of await this.db.query('select board_subscribers($1) as user_id', [request.board_id])) {
              await this.matching.recompute(subscriber.user_id);
              void this.assessment.automaticForBoard(subscriber.user_id, request.board_id);
            }
            succeeded = true;
          }
        } catch {
          this.log.warn('Queued board refresh did not complete.');
        }
        await this.db.query('select finish_board_refresh($1, $2, $3)', [request.id, request.attempts, succeeded]);
      }
    } catch {
      this.log.warn('Board refresh queue could not be processed.');
    } finally {
      this.queueRunning = false;
    }
  }

  async refreshDue() {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;
    try {
      const due = await this.db.query('select board_id, now() as cutoff from scheduled_boards_due(5)');
      for (const b of due) {
        try {
          await this.syncBoard(b.board_id);
          for (const s of await this.db.query('select board_subscribers($1) as user_id', [b.board_id])) {
            await this.matching.recompute(s.user_id);
            void this.assessment.automaticForBoard(s.user_id, b.board_id);
          }
          await this.db.query('select acknowledge_board_schedule($1, $2)', [b.board_id, b.cutoff]);
        } catch {
          this.log.warn('Scheduled board refresh did not complete; it will be retried.');
        }
      }
    } catch (e) {
      this.log.error(`Scheduled refresh failed: ${(e as Error).message}`);
    } finally {
      this.schedulerRunning = false;
    }
  }

  /** Computes countries for boards stored before countries existed, then re-scores their subscribers. */
  async backfillCountries() {
    try {
      const boards = await this.db.query('select distinct board_id from jobs where countries is null');
      for (const b of boards) {
        await this.assignCountries(b.board_id);
        for (const s of await this.db.query('select board_subscribers($1) as user_id', [b.board_id])) {
          await this.matching.recompute(s.user_id);
        }
      }
      if (boards.length) this.log.log(`Assigned countries to jobs on ${boards.length} board(s).`);
    } catch (e) {
      this.log.error(`Country backfill failed: ${(e as Error).message}`);
    }
  }

  /**
   * Stores each job's countries. Postings that name only a small town or just "Remote" get the
   * board's home country when nearly all of its other jobs are in one country.
   */
  async assignCountries(boardId: string, inferBoardCountry = true) {
    const jobs = await this.db.query('select id, location, title from jobs where board_id = $1', [boardId]);
    const inferred = jobs.map((j) => jobCountries(j.location, j.title));
    const home = inferBoardCountry ? boardHomeCountry(inferred) : null;
    const rows = jobs.map((j, i) => ({ id: j.id, countries: inferred[i].length || !home ? inferred[i] : [home] }));
    await this.db.query(
      `update jobs set countries = array(select jsonb_array_elements_text(x.countries))
       from jsonb_to_recordset($1::jsonb) as x(id uuid, countries jsonb) where jobs.id = x.id`,
      [JSON.stringify(rows)],
    );
  }

  /** Fetches one board and upserts its jobs. Shared by all users subscribed to that board. */
  async syncBoard(boardId: string, force = false, request?: RefreshClaim): Promise<{ jobs: number; skipped: boolean }> {
    const [board] = await this.db.query('select * from boards where id = $1', [boardId]);
    if (!board) throw new BadRequestException('Unknown board.');
    const fresh =
      board.last_synced_at && Date.now() - new Date(board.last_synced_at).getTime() < MIN_RESYNC_MINUTES * 60_000;
    if (fresh && !force && !board.last_error) return { jobs: 0, skipped: true };
    const provider = boardProviders.get(board.kind as BoardKind);
    if (!provider) throw new BadRequestException('Unsupported board provider.');
    await this.db.query(
      `update job_discovery_runs set status = 'failed', ended_at = now(), error_details = 'Run expired before completion.'
       where board_id = $1 and status = 'running' and started_at < now() - interval '30 minutes'`, [boardId],
    );
    const [run] = await this.db.query(
      `insert into job_discovery_runs (board_id, status) values ($1, 'running')
       on conflict (board_id) where status = 'running' do nothing returning id`, [boardId],
    );
    if (!run) return { jobs: 0, skipped: true };
    try {
      return await this.ingestBoard(board, provider, run.id, request);
    } catch {
      const message = 'Job board refresh failed. Check the board address or try again.';
      await this.db.query(
        `with failed as (
           update job_discovery_runs set status = 'failed', ended_at = now(), error_details = $2
           where id = $1 and status = 'running' returning board_id
         )
         update boards set last_error = $2, last_synced_at = now()
         where id in (select board_id from failed)`,
        [run.id, message],
      );
      throw new BadGatewayException(message);
    }
  }

  private async ingestBoard(
    board: { id: string; kind: BoardKind; token: string; company_name: string },
    provider: JobDiscoveryProvider,
    runId: string,
    request?: RefreshClaim,
  ) {
    const boardId = board.id;
    // Postings already stored with a description, so boards that charge one request per
    // description (SmartRecruiters) only fetch new or changed ones.
    const stored = new Map<string, { posted_at: string | null; description: string; content_hash: string }>(
      board.kind === 'smartrecruiters'
        ? (
            await this.db.query(
              `select external_id, posted_at, description, content_hash from jobs where board_id = $1 and description <> ''`,
              [boardId],
            )
          ).map((r) => [r.external_id, { ...r, posted_at: r.posted_at ? new Date(r.posted_at).toISOString() : null }])
        : [],
    );
    const jobs = (await provider.fetch(board.token, {
        known: new Map([...stored].map(([id, r]) => [id, r.posted_at])),
    })).map(({ keep_description, ...j }) => {
      const prev = keep_description ? stored.get(j.external_id) : undefined;
      return prev ? { ...j, description: prev.description, content_hash: prev.content_hash } : j;
    });
    const valid = jobs.filter((j) => j.external_id && j.title && j.url);
    const unique = [...new Map(valid.map((j) => [j.external_id, j])).values()];
    if (jobs.length && !unique.length) throw new Error('No valid records in board response');
    // One statement, so now() is identical for the upsert and for closing postings that disappeared.
    const [written] = await this.db.query(
      `with active as (
         select id from job_discovery_runs
         where id = $3 and status = 'running'
           and case when $8::uuid is null then true else reserve_board_refresh_save($8, $9, $1) end
         for update
       ), existing as materialized (
         select external_id, content_hash from jobs where board_id = $1
       ), up as (
         insert into jobs (board_id, external_id, company, title, location, remote, employment_type, workplace,
                           seniority, url, apply_url, description, content_hash, posted_at, last_seen_at)
         select $1, x.external_id, x.company, x.title, x.location, x.remote, x.employment_type, x.workplace,
                x.seniority, x.url, x.apply_url, x.description, x.content_hash, x.posted_at, now()
         from jsonb_to_recordset($2::jsonb) as x(external_id text, company text, title text, location text,
              remote boolean, employment_type text, workplace text, seniority text, url text, apply_url text,
              description text, content_hash text, posted_at timestamptz)
         where exists (select 1 from active)
         on conflict (board_id, external_id) do update set
           company = excluded.company, title = excluded.title, location = excluded.location,
           remote = excluded.remote, employment_type = excluded.employment_type, workplace = excluded.workplace,
           seniority = excluded.seniority, url = excluded.url, apply_url = excluded.apply_url,
           description = excluded.description, content_hash = excluded.content_hash,
           posted_at = excluded.posted_at, last_seen_at = now(), closed_at = null
         returning id, external_id, content_hash
       ), closed as (
         update jobs set closed_at = now()
         where board_id = $1 and closed_at is null and exists (select 1 from active) and $7
           and id not in (select id from up)
       )
       update job_discovery_runs set jobs_discovered = $4, duplicates_prevented = $5, failed_records = $6,
         jobs_inserted = (select count(*) from up left join existing using (external_id) where existing.external_id is null),
         jobs_updated = (select count(*) from up join existing using (external_id) where up.content_hash <> existing.content_hash)
       where id in (select id from active) returning id`,
      [boardId, JSON.stringify(unique), runId, jobs.length, valid.length - unique.length, jobs.length - valid.length,
        board.kind !== 'arbeitnow', request?.id ?? null, request?.attempts ?? null],
    );
    if (!written) {
      await this.db.query(
        "update job_discovery_runs set status = 'cancelled', ended_at = now() where id = $1 and status = 'running'",
        [runId],
      );
      return { jobs: 0, skipped: true };
    }
    await this.assignCountries(boardId, board.kind !== 'arbeitnow');
    const company = board.kind === 'arbeitnow' ? 'Arbeitnow' : unique[0]?.company ?? board.company_name;
    await this.db.query(
      `with done as (
         update job_discovery_runs set status = 'completed', ended_at = now() where id = $1 and status = 'running' returning board_id
       )
       update boards set last_synced_at = now(), last_error = null, company_name = $2 where id in (select board_id from done)`,
      [runId, company],
    );
    return { jobs: unique.length, skipped: false };
  }
}

const addSchema = z.object({
  kind: z.enum(BOARD_KINDS).optional(),
  ref: z.string().trim().min(1).max(300),
});

@Controller('me/sources')
@UseGuards(AuthGuard)
export class SourcesController {
  constructor(
    private db: Db,
    private sources: SourcesService,
    private matching: MatchingService,
  ) {}

  @Get('requests')
  requests(@UserId() userId: string) {
    return this.db.asUser(userId, (q) => q(
      `select r.id, r.board_id, r.status, r.requested_at, r.started_at, r.ended_at, r.attempts, r.error_details, b.token,
         (r.status in ('queued','running') and r.postings_saved_at is null) as can_cancel
       from board_refresh_requests r join boards b on b.id = r.board_id
       where r.user_id = $1 order by (r.status in ('queued','running')) desc, r.requested_at desc limit 50`, [userId],
    ));
  }

  @Post(':id/refresh')
  @HttpCode(202)
  async enqueue(@UserId() userId: string, @Param('id', ParseUUIDPipe) boardId: string) {
    const request = await this.db.asUser(userId, async (q) => {
      const [subscription] = await q(
        'select 1 from job_sources where user_id = $1 and board_id = $2 and enabled for update', [userId, boardId],
      );
      if (!subscription) throw new BadRequestException('Board subscription not found.');
      const [existing] = await q(
        "select id, status from board_refresh_requests where user_id = $1 and board_id = $2 and status in ('queued','running')",
        [userId, boardId],
      );
      if (existing) return existing;
      const [created] = await q(
        'insert into board_refresh_requests (user_id,board_id) values ($1,$2) returning id,status', [userId, boardId],
      );
      return created;
    });
    void this.sources.processRefreshQueue();
    return request;
  }

  @Post('requests/:id/cancel')
  async cancelRequest(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    const [cancelled] = await this.db.asUser(userId, (q) => q(
      `update board_refresh_requests set status = 'cancelled', ended_at = now()
       where user_id = $1 and id = $2 and status in ('queued','running') and postings_saved_at is null
       returning id, status`, [userId, id],
    ));
    if (!cancelled) throw new ConflictException('This refresh can no longer be cancelled.');
    return cancelled;
  }

  @Get('runs')
  runs(@UserId() userId: string) {
    return this.db.asUser(userId, (q) => q(
      `select r.*, b.kind, b.token from job_discovery_runs r
       join job_sources s on s.board_id = r.board_id and s.user_id = $1
       join boards b on b.id = r.board_id
       order by r.started_at desc, r.id limit 50`, [userId],
    ));
  }

  @Patch(':id/schedule')
  async updateSchedule(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() input: unknown) {
    const { times } = parse(z.object({ times: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).max(12) }), input);
    return this.db.asUser(userId, async (q) => {
      const [row] = await q(
        `update job_sources set schedule_times = $3::time[], scheduled_through = now()
         where user_id = $1 and board_id = $2 returning schedule_times`,
        [userId, id, [...new Set(times)].sort()],
      );
      if (!row) throw new BadRequestException('Board subscription not found.');
      return row;
    });
  }

  @Get()
  list(@UserId() userId: string) {
    return this.db.asUser(userId, (q) =>
      q(
        `select b.id, b.kind, b.token, b.company_name, b.last_synced_at, b.last_error, s.enabled, s.schedule_times,
                (select count(*)::int from jobs j where j.board_id = b.id and j.closed_at is null) as open_jobs
         from job_sources s join boards b on b.id = s.board_id
         order by b.company_name, b.token`,
      ),
    );
  }

  @Post()
  async add(@UserId() userId: string, @Body() body: unknown) {
    const { kind, ref } = parse(addSchema, body);
    const parsed = parseBoardRef(ref, kind);
    if (!parsed) {
      throw new BadRequestException(boardRefHelp(ref, kind));
    }
    const [board] = await this.db.query(
      `insert into boards (kind, token) values ($1, $2)
       on conflict (kind, token) do update set token = excluded.token returning id, last_synced_at`,
      [parsed.kind, parsed.token.toLowerCase()],
    );
    // Validate against the live board before subscribing, so typos fail immediately.
    const result = await this.sources.syncBoard(board.id);
    await this.db.asUser(userId, async (q) => {
      await q('insert into job_sources (user_id, board_id) values ($1, $2) on conflict do nothing', [userId, board.id]);
      await audit(q, userId, 'source.added', board.id, parsed);
    });
    const matched = await this.matching.recompute(userId);
    return { boardId: board.id, ...parsed, jobs: result.jobs, matched };
  }

  @Delete(':boardId')
  @HttpCode(204)
  async remove(@UserId() userId: string, @Param('boardId', ParseUUIDPipe) boardId: string) {
    await this.db.asUser(userId, async (q) => {
      await q('delete from job_sources where board_id = $1', [boardId]);
      // Keep matches that already have an application draft; drop the rest.
      await q(
        `delete from job_matches m using jobs j
         where j.id = m.job_id and j.board_id = $1
           and not exists (select from application_drafts d where d.job_id = m.job_id)`,
        [boardId],
      );
      await audit(q, userId, 'source.removed', boardId);
    });
  }

  @Post('sync')
  @HttpCode(200)
  async sync(@UserId() userId: string) {
    const boards = await this.db.asUser(userId, (q) => q('select board_id from job_sources where enabled'));
    const errors: string[] = [];
    let refreshed = 0;
    for (const b of boards) {
      try {
        if (!(await this.sources.syncBoard(b.board_id)).skipped) refreshed++;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    const matched = await this.matching.recompute(userId);
    return { boards: boards.length, refreshed, matched, errors };
  }
}

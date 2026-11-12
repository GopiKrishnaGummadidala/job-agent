import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, parse, UserId } from '../auth';
import { config } from '../config';
import { audit, Db } from '../db';
import { MatchingService } from '../matching/matching.service';
import { BOARD_KINDS, BoardKind, boardRefHelp, fetchBoard, parseBoardRef } from './adapters';

const MIN_RESYNC_MINUTES = 15;

@Injectable()
export class SourcesService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Sources');
  private timer?: NodeJS.Timeout;

  constructor(
    private db: Db,
    private matching: MatchingService,
  ) {}

  onModuleInit() {
    if (!config.scheduler) return;
    // The database is the queue: boards_due() returns stale boards that still have subscribers.
    this.timer = setInterval(() => void this.refreshDue(), 30 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async refreshDue() {
    try {
      const due = await this.db.query(`select id from boards_due(interval '6 hours', 5)`);
      for (const b of due) {
        await this.syncBoard(b.id).catch(() => undefined);
        for (const s of await this.db.query('select board_subscribers($1) as user_id', [b.id])) {
          await this.matching.recompute(s.user_id);
        }
      }
    } catch (e) {
      this.log.error(`Scheduled refresh failed: ${(e as Error).message}`);
    }
  }

  /** Fetches one board and upserts its jobs. Shared by all users subscribed to that board. */
  async syncBoard(boardId: string, force = false): Promise<{ jobs: number; skipped: boolean }> {
    const [board] = await this.db.query('select * from boards where id = $1', [boardId]);
    if (!board) throw new BadRequestException('Unknown board.');
    const fresh =
      board.last_synced_at && Date.now() - new Date(board.last_synced_at).getTime() < MIN_RESYNC_MINUTES * 60_000;
    if (fresh && !force && !board.last_error) return { jobs: 0, skipped: true };

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
    let jobs;
    try {
      jobs = await fetchBoard(board.kind as BoardKind, board.token, {
        known: new Map([...stored].map(([id, r]) => [id, r.posted_at])),
      });
      jobs = jobs.map(({ keep_description, ...j }) => {
        const prev = keep_description ? stored.get(j.external_id) : undefined;
        return prev ? { ...j, description: prev.description, content_hash: prev.content_hash } : j;
      });
    } catch (e) {
      const message = (e as Error).message;
      await this.db.query('update boards set last_error = $2, last_synced_at = now() where id = $1', [boardId, message]);
      throw new BadGatewayException(message);
    }
    const unique = [...new Map(jobs.filter((j) => j.title && j.url).map((j) => [j.external_id, j])).values()];
    // One statement, so now() is identical for the upsert and for closing postings that disappeared.
    await this.db.query(
      `with up as (
         insert into jobs (board_id, external_id, company, title, location, remote, employment_type, workplace,
                           seniority, url, apply_url, description, content_hash, posted_at, last_seen_at)
         select $1, x.external_id, x.company, x.title, x.location, x.remote, x.employment_type, x.workplace,
                x.seniority, x.url, x.apply_url, x.description, x.content_hash, x.posted_at, now()
         from jsonb_to_recordset($2::jsonb) as x(external_id text, company text, title text, location text,
              remote boolean, employment_type text, workplace text, seniority text, url text, apply_url text,
              description text, content_hash text, posted_at timestamptz)
         on conflict (board_id, external_id) do update set
           company = excluded.company, title = excluded.title, location = excluded.location,
           remote = excluded.remote, employment_type = excluded.employment_type, workplace = excluded.workplace,
           seniority = excluded.seniority, url = excluded.url, apply_url = excluded.apply_url,
           description = excluded.description, content_hash = excluded.content_hash,
           posted_at = excluded.posted_at, last_seen_at = now(), closed_at = null
         returning id
       )
       update jobs set closed_at = now()
       where board_id = $1 and closed_at is null and id not in (select id from up)`,
      [boardId, JSON.stringify(unique)],
    );
    const company = unique[0]?.company ?? board.company_name;
    await this.db.query(
      'update boards set last_synced_at = now(), last_error = null, company_name = $2 where id = $1',
      [boardId, company],
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

  @Get()
  list(@UserId() userId: string) {
    return this.db.asUser(userId, (q) =>
      q(
        `select b.id, b.kind, b.token, b.company_name, b.last_synced_at, b.last_error, s.enabled,
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

import { Injectable } from '@nestjs/common';
import { Db, Q } from '../db';
import { scoreJob } from './score';

export async function loadProfile(q: Q, userId: string) {
  await q('insert into candidate_profiles (user_id) values ($1) on conflict do nothing', [userId]);
  return (await q('select * from candidate_profiles where user_id = $1', [userId]))[0];
}

export async function loadPrefs(q: Q, userId: string) {
  await q(`insert into job_preferences (user_id, name) values ($1, 'Default') on conflict do nothing`, [userId]);
  return (await q(`select * from job_preferences where user_id = $1 and name = 'Default'`, [userId]))[0];
}

@Injectable()
export class MatchingService {
  constructor(private db: Db) {}

  /** Re-scores every open job on the user's boards. Pure computation, so it costs nothing to rerun. */
  async recompute(userId: string): Promise<number> {
    return this.db.asUser(userId, async (q) => {
      const profile = await loadProfile(q, userId);
      const prefs = await loadPrefs(q, userId);
      const jobs = await q(
        `select j.id, j.company, j.title, j.location, j.remote, j.description
         from jobs j join job_sources s on s.board_id = j.board_id
         where s.enabled and j.closed_at is null`,
      );
      const rows = jobs.map((j) => ({ job_id: j.id, ...scoreJob(j, profile, prefs) }));
      await q(
        `insert into job_matches (user_id, job_id, score, filtered, reasons, unknowns, computed_at)
         select $1, x.job_id, x.score, x.filtered, x.reasons, x.unknowns, now()
         from jsonb_to_recordset($2::jsonb)
           as x(job_id uuid, score int, filtered boolean, reasons jsonb, unknowns jsonb)
         on conflict (user_id, job_id) do update set
           score = excluded.score, filtered = excluded.filtered, reasons = excluded.reasons,
           unknowns = excluded.unknowns, computed_at = now()`,
        [userId, JSON.stringify(rows)],
      );
      return rows.length;
    });
  }
}

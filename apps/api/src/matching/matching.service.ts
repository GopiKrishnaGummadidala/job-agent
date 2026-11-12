import { Injectable } from '@nestjs/common';
import { Db, Q } from '../db';
import { scoreJob, tagMatches } from './score';

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
        `select j.id, j.company, j.title, j.location, j.remote, j.description, j.countries
         from jobs j join job_sources s on s.board_id = j.board_id
         where s.enabled and j.closed_at is null`,
      );
      const tags: string[] = (await q('select distinct tag from resume_tags')).map((r) => r.tag);
      const rows = jobs.map((j) => {
        const text = `${j.title}\n${j.description}`;
        return { job_id: j.id, ...scoreJob(j, profile, prefs), tag_hits: tags.filter((t) => tagMatches(text, t)) };
      });
      await q(
        `insert into job_matches (user_id, job_id, score, filtered, reasons, unknowns, tag_hits, computed_at)
         select $1, x.job_id, x.score, x.filtered, x.reasons, x.unknowns,
                array(select jsonb_array_elements_text(x.tag_hits)), now()
         from jsonb_to_recordset($2::jsonb)
           as x(job_id uuid, score int, filtered boolean, reasons jsonb, unknowns jsonb, tag_hits jsonb)
         on conflict (user_id, job_id) do update set
           score = excluded.score, filtered = excluded.filtered, reasons = excluded.reasons,
           unknowns = excluded.unknowns, tag_hits = excluded.tag_hits, computed_at = now()`,
        [userId, JSON.stringify(rows)],
      );
      return rows.length;
    });
  }
}

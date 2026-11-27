import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Db, type Q } from '../src/db';
import { AiService } from '../src/ai/ai.service';
import { JobAssessmentService } from '../src/ai/job-assessment.service';
import { MatchingService } from '../src/matching/matching.service';
import { type NormalizedJob } from '../src/sources/adapters';
import { boardProviders } from '../src/sources/discovery-provider';
import { SourcesService } from '../src/sources/sources';
import { Harness } from './helpers';

const h = new Harness();
before(() => h.start());
after(() => h.stop());

test('board refresh records source references, duplicates and changes without replacing the job', async () => {
  const owner = await h.user();
  const outsider = await h.user();
  const { boardId } = await h.seedJob([owner]);
  const db = new Db();
  const original = boardProviders.get('greenhouse')!;
  let job: NormalizedJob = {
    external_id: '1', title: 'Engineer', company: 'Example', location: 'Hamburg', remote: false,
    employment_type: 'full_time', workplace: 'onsite', seniority: 'senior',
    url: 'https://example.test/job/1', apply_url: 'https://example.test/apply?utm_source=email&job=1',
    description: 'TypeScript', content_hash: 'updated', posted_at: null,
  };
  boardProviders.set('greenhouse', { id: 'greenhouse', fetch: async () => [job, job] });
  try {
    const service = new SourcesService(db, new MatchingService(db), new JobAssessmentService(db, new AiService(db)));
    const query: Q = async (sql, args) => (await h.owner.query(sql, args)).rows;
    const [originalJob] = await query('select id from jobs where board_id = $1', [boardId]);
    assert.deepEqual(await service.syncBoard(boardId, true), { jobs: 1, skipped: false });
    const [reference] = await query('select job_id, normalized_url from job_source_references where board_id = $1', [boardId]);
    assert.equal(reference.job_id, originalJob.id);
    assert.equal(reference.normalized_url, 'https://example.test/apply?job=1');
    const { body: [run] } = await owner.call('GET', '/me/sources/runs');
    assert.equal(run.status, 'completed');
    assert.equal(run.jobs_updated, 1);
    assert.equal(run.jobs_inserted, 0);
    assert.equal(run.duplicates_prevented, 1);
    assert.deepEqual((await outsider.call('GET', '/me/sources/runs')).body, []);
    job = { ...job, external_id: '2' };
    await service.syncBoard(boardId, true);
    const [second] = (await owner.call('GET', '/me/sources/runs')).body;
    assert.equal(second.jobs_inserted, 1);
    assert.notEqual((await query('select closed_at from jobs where id = $1', [originalJob.id]))[0].closed_at, null);
  } finally {
    boardProviders.set('greenhouse', original);
    await db.onModuleDestroy();
  }
});

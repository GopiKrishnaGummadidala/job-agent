import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchBoard, parseBoardRef } from '../src/sources/adapters';

test('Arbeitnow ingests valid postings and follows only its own bounded page sequence', async (t) => {
  const requests: string[] = [];
  const posting = {
    slug: 'senior-typescript-hamburg', title: 'Senior TypeScript Engineer', company_name: 'Example',
    description: '&lt;p&gt;Build TypeScript services&lt;/p&gt;', location: 'Hamburg',
    remote: true, url: 'https://www.arbeitnow.com/jobs/example/engineer', created_at: 1700000000,
  };
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requests.push(url);
    return Response.json({
      data: requests.length === 1 ? [posting, { slug: 'malformed' }] : [],
      links: { next: 'https://example.test/untrusted-next-url' },
    });
  });
  assert.deepEqual(parseBoardRef('https://www.arbeitnow.com/'), { kind: 'arbeitnow', token: 'arbeitnow' });
  const jobs = await fetchBoard('arbeitnow', 'arbeitnow');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].description, 'Build TypeScript services');
  assert.equal(jobs[0].workplace, 'remote');
  assert.equal(jobs[0].posted_at, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(requests, [1, 2, 3].map((page) => 'https://www.arbeitnow.com/api/job-board-api?page=' + page));
});

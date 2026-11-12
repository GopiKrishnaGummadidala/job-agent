import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Client } from 'pg';
import { config } from '../src/config';
import { Harness, resumeForm, TestUser, tinyPdf } from './helpers';

const h = new Harness();
before(() => h.start());
after(() => h.stop());

async function setupUser(u: TestUser) {
  await u.call('PUT', '/me/profile', {
    full_name: 'Ada Example', email: 'ada@example.test', phone: '', linkedin_url: '', headline: 'Backend engineer',
    location: 'Berlin', work_authorization: 'EU citizen', years_experience: 7, skills: ['TypeScript', 'PostgreSQL'],
    languages: ['English'], summary: '',
  });
  const pdf = await u.call('POST', '/me/resumes', resumeForm(tinyPdf('Ada Example TypeScript PostgreSQL')));
  assert.equal(pdf.status, 201, JSON.stringify(pdf.body));
  return pdf.body;
}

describe('authentication and CSRF', () => {
  test('protected routes require a session', async () => {
    const r = await fetch(`${h.base}/me/profile`);
    assert.equal(r.status, 401);
  });

  test('repeated failed sign-ins are rate limited', async () => {
    process.env.AUTH_RATE_LIMIT = '3';
    try {
      const attempt = () =>
        fetch(`${h.base}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-requested-with': 'job-agent' },
          body: JSON.stringify({ email: 'limit@example.test', password: 'wrong-password' }),
        }).then((r) => r.status);
      const statuses = [await attempt(), await attempt(), await attempt(), await attempt()];
      assert.deepEqual(statuses, [401, 401, 401, 429]);
    } finally {
      process.env.AUTH_RATE_LIMIT = '1000';
    }
  });

  test('state-changing requests without the app header are refused', async () => {
    const r = await fetch(`${h.base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.test', password: 'whatever-123' }),
    });
    assert.equal(r.status, 403);
  });
});

describe('tenant isolation', () => {
  test('user B cannot read or change user A data, even with the right ids', async () => {
    const a = await h.user();
    const b = await h.user();
    const resume = await setupUser(a);
    const { jobId } = await h.seedJob([a]);
    await a.call('POST', '/me/sources/sync');
    const draft = (await a.call('POST', `/me/jobs/${jobId}/prepare`)).body;
    assert.ok(draft.id);

    assert.equal((await b.call('GET', `/me/application-drafts/${draft.id}`)).status, 404);
    assert.equal((await b.call('PATCH', `/me/application-drafts/${draft.id}`, { cover_letter: 'hijack' })).status, 404);
    assert.equal((await b.call('POST', `/me/application-drafts/${draft.id}/approve`, { content_hash: draft.content_hash })).status, 404);
    assert.equal((await b.call('GET', `/me/resumes/${resume.id}/file`)).status, 404);
    assert.equal((await b.call('DELETE', `/me/resumes/${resume.id}`)).status, 404);
    assert.equal((await b.call('GET', `/me/jobs/${jobId}`)).status, 404, 'job is not on B’s boards');
    assert.deepEqual((await b.call('GET', '/me/resumes')).body, []);
    assert.deepEqual((await b.call('GET', '/me/application-drafts')).body, []);
    const profileB = (await b.call('GET', '/me/profile')).body.profile;
    assert.equal(profileB.full_name, '');
  });

  test('row-level security hides rows when no user is set on the connection', async () => {
    const a = await h.user();
    await setupUser(a);
    const app = new Client({ connectionString: config.databaseUrl });
    await app.connect();
    try {
      const { rows } = await app.query('select count(*)::int as n from resume_files');
      assert.equal(rows[0].n, 0);
      await assert.rejects(app.query(`insert into audit_events (user_id, type) values ($1, 'forged')`, [a.id]));
    } finally {
      await app.end();
    }
  });
});

describe('resumes are read-only', () => {
  test('stored bytes are identical to the upload and the app role cannot update them', async () => {
    const a = await h.user();
    const original = tinyPdf('Read only resume');
    const up = await a.call('POST', '/me/resumes', resumeForm(original, 'cv.pdf'));
    assert.equal(up.body.sha256, createHash('sha256').update(original).digest('hex'));
    const dl = await fetch(`${h.base}/me/resumes/${up.body.id}/file`, {
      headers: { cookie: (await loginCookie(a)) },
    });
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), original);

    const app = new Client({ connectionString: config.databaseUrl });
    await app.connect();
    try {
      await app.query('begin');
      await app.query(`select set_config('app.user_id', $1, true)`, [a.id]);
      await assert.rejects(app.query(`update resume_files set content = 'x' where id = $1`, [up.body.id]), /permission denied/);
      await app.query('rollback');
    } finally {
      await app.end();
    }

    for (const method of ['PUT', 'PATCH']) {
      assert.equal((await a.call(method, `/me/resumes/${up.body.id}`, {})).status, 404);
    }
  });

  test('non-resume files are rejected', async () => {
    const a = await h.user();
    const fd = new FormData();
    fd.append('file', new Blob(['MZ fake exe']), 'resume.pdf');
    assert.equal((await a.call('POST', '/me/resumes', fd)).status, 400);
  });
});

describe('approval workflow', () => {
  test('approval binds content; edits invalidate it; submission requires it and is idempotent', async () => {
    const a = await h.user();
    await setupUser(a);
    const { jobId } = await h.seedJob([a]);
    await a.call('POST', '/me/sources/sync');
    let d = (await a.call('POST', `/me/jobs/${jobId}/prepare`)).body;
    assert.equal(d.status, 'awaiting_review');
    assert.match(d.cover_letter, /Dear Acme hiring team/);
    assert.ok(d.resume_id, 'recommended resume is preselected');

    // Cannot record a submission or open the assist without approval.
    const key = `k-${Date.now()}-abcdef`;
    assert.equal((await a.call('POST', `/me/application-drafts/${d.id}/submitted`, undefined, { 'idempotency-key': key })).status, 409);
    assert.equal((await a.call('POST', `/me/application-drafts/${d.id}/assist`)).status, 409);

    // A stale view cannot be approved.
    assert.equal((await a.call('POST', `/me/application-drafts/${d.id}/approve`, { content_hash: '0'.repeat(64) })).status, 409);

    d = (await a.call('POST', `/me/application-drafts/${d.id}/approve`, { content_hash: d.content_hash })).body;
    assert.equal(d.status, 'approved');
    assert.equal(d.approval_valid, true);

    // Private notes do not affect approval; content does.
    d = (await a.call('PATCH', `/me/application-drafts/${d.id}`, { notes: 'call recruiter' })).body;
    assert.equal(d.approval_valid, true);
    d = (await a.call('PATCH', `/me/application-drafts/${d.id}`, { cover_letter: `${d.cover_letter}\nP.S.` })).body;
    assert.equal(d.status, 'awaiting_review');
    assert.equal(d.approval_valid, false);
    assert.equal((await a.call('POST', `/me/application-drafts/${d.id}/submitted`, undefined, { 'idempotency-key': key })).status, 409);

    d = (await a.call('POST', `/me/application-drafts/${d.id}/approve`, { content_hash: d.content_hash })).body;
    const first = await a.call('POST', `/me/application-drafts/${d.id}/submitted`, undefined, { 'idempotency-key': key });
    assert.equal(first.status, 200);
    const again = await a.call('POST', `/me/application-drafts/${d.id}/submitted`, undefined, { 'idempotency-key': key });
    const otherKey = await a.call('POST', `/me/application-drafts/${d.id}/submitted`, undefined, { 'idempotency-key': `${key}-2` });
    assert.equal(again.body.id, first.body.id);
    assert.equal(otherKey.body.id, first.body.id);
    assert.equal((await a.call('GET', '/me/applications')).body.length, 1);
    assert.equal(first.body.snapshot.content_hash, d.content_hash);

    // Submitted applications are frozen.
    assert.equal((await a.call('PATCH', `/me/application-drafts/${d.id}`, { cover_letter: 'changed' })).status, 409);

    const audit = await h.owner.query('select type from audit_events where user_id = $1 order by id', [a.id]);
    const types = audit.rows.map((r) => r.type);
    for (const t of ['draft.prepared', 'draft.approved', 'approval.invalidated', 'application.submitted']) {
      assert.ok(types.includes(t), `audit has ${t}`);
    }
  });

  test('a draft without a resume cannot be approved', async () => {
    const a = await h.user();
    const { jobId } = await h.seedJob([a]);
    await a.call('POST', '/me/sources/sync');
    const d = (await a.call('POST', `/me/jobs/${jobId}/prepare`)).body;
    assert.equal(d.resume_id, null);
    assert.equal((await a.call('POST', `/me/application-drafts/${d.id}/approve`, { content_hash: d.content_hash })).status, 400);
  });

  test('AI calls are refused when no provider is configured', async () => {
    const a = await h.user();
    const { jobId } = await h.seedJob([a]);
    await a.call('POST', '/me/sources/sync');
    assert.equal((await a.call('POST', `/me/jobs/${jobId}/assess`)).status, 400);
  });
});

describe('CV tags', () => {
  test('tags filter jobs and pick the matching CV; other users cannot tag your CVs', async () => {
    const a = await h.user();
    const b = await h.user();
    const fd = resumeForm(tinyPdf('Ada Example C# ASP.NET Core'), 'dotnet.pdf');
    fd.append('tags', '.NET, Azure');
    const dotnet = (await a.call('POST', '/me/resumes', fd)).body;
    assert.deepEqual(dotnet.tags, ['.NET', 'Azure']);
    const node = (await a.call('POST', '/me/resumes', resumeForm(tinyPdf('Ada Example Node.js Express'), 'node.pdf'))).body;
    const tagged = await a.call('PUT', `/me/resumes/${node.id}/tags`, { tags: ['node', ' .net ', 'NODE'] });
    assert.deepEqual(tagged.body.tags, ['.NET', 'node'], 'deduped case-insensitively, reusing the existing ".NET" spelling');
    await a.call('PUT', `/me/resumes/${node.id}/tags`, { tags: ['Node'] });

    const { jobId: dotnetJob } = await h.seedJob([a], { title: 'Senior Backend Engineer', description: 'Build services in C# on Azure.' });
    const { jobId: nodeJob } = await h.seedJob([a], { title: 'Senior Backend Engineer', description: 'Our stack is Node.js and TypeScript.' });
    await a.call('POST', '/me/sources/sync');

    const ids = async (qs: string) => (await a.call('GET', `/me/jobs?minScore=0&${qs}`)).body.map((j: any) => j.id);
    assert.deepEqual(await ids('tags=.NET'), [dotnetJob]);
    assert.deepEqual(await ids('tags=Node'), [nodeJob]);
    assert.deepEqual((await ids('tags=.NET,Node')).sort(), [dotnetJob, nodeJob].sort());
    assert.deepEqual(await ids('tags=.NET,Azure&tagMode=all'), [dotnetJob]);
    assert.deepEqual(await ids('tags=.NET,Node&tagMode=all'), []);

    const detail = (await a.call('GET', `/me/jobs/${nodeJob}`)).body;
    assert.equal(detail.resume.resumeId, node.id);
    assert.deepEqual(detail.resume.tagHits, ['Node']);
    const draft = (await a.call('POST', `/me/jobs/${dotnetJob}/prepare`)).body;
    assert.equal(draft.resume_id, dotnet.id);

    const tags = (await a.call('GET', '/me/resumes/tags')).body.map((t: any) => t.tag);
    assert.deepEqual(tags, ['.NET', 'Azure', 'Node']);

    assert.equal((await b.call('PUT', `/me/resumes/${dotnet.id}/tags`, { tags: ['hijack'] })).status, 404);
    assert.deepEqual((await b.call('GET', '/me/resumes/tags')).body, []);
    await assert.rejects(
      h.owner.query(`insert into resume_tags (user_id, resume_id, tag) values ($1, $2, 'x')`, [b.id, dotnet.id]),
      /foreign key/,
      'a tag row cannot point at another user’s resume, even bypassing the API',
    );

    // Tagged CVs stay byte-for-byte unchanged.
    const [row] = (await h.owner.query('select sha256 from resume_files where id = $1', [dotnet.id])).rows;
    assert.equal(row.sha256, dotnet.sha256);
  });
});

describe('job search filters', () => {
  test('date posted, type, workplace, seniority, company and text filters', async () => {
    const a = await h.user();
    await a.call('PUT', '/me/preferences', {
      titles: ['Engineer'], keywords: [], locations: ['Hamburg'], remote_ok: true, salary_floor: null,
      excluded_companies: [], excluded_keywords: [], min_score: 40,
    });
    const { jobId: fresh } = await h.seedJob([a], { title: 'Senior Engineer', company: 'Acme, Inc.', posted_days_ago: 0 });
    const { jobId: week } = await h.seedJob([a], {
      title: 'Engineer (Part-time)', company: 'Beta', employment_type: 'part_time', workplace: 'hybrid',
      location: 'Hamburg', seniority: 'mid', posted_days_ago: 5,
    });
    const { jobId: old } = await h.seedJob([a], {
      title: 'Engineering Intern', company: 'Gamma', employment_type: 'internship', workplace: 'onsite',
      location: 'Hamburg', seniority: 'intern', posted_days_ago: 40,
    });
    const { jobId: elsewhere } = await h.seedJob([a], { title: 'Engineer', company: 'Delta', workplace: 'onsite', location: 'Tokyo' });
    await a.call('POST', '/me/sources/sync');

    const ids = async (qs: string) => (await a.call('GET', `/me/jobs?minScore=0&${qs}`)).body.map((j: any) => j.id).sort();
    const sorted = (...x: string[]) => x.sort();
    assert.deepEqual(await ids('posted=1d'), [fresh]);
    assert.deepEqual(await ids('posted=7d'), sorted(fresh, week));
    assert.deepEqual(await ids('posted=any'), sorted(fresh, week, old));
    assert.deepEqual(await ids('type=part_time,internship'), sorted(week, old));
    assert.deepEqual(await ids('workplace=remote&workplace=hybrid'), sorted(fresh, week));
    assert.deepEqual(await ids('seniority=intern'), [old]);
    assert.deepEqual(await ids(`company=${encodeURIComponent('Acme, Inc.')}`), [fresh], 'company names may contain commas');
    assert.deepEqual(await ids('q=hamburg'), sorted(week, old), 'search covers location');
    assert.deepEqual(await ids('q=100%25'), [], 'LIKE wildcards in the search are matched literally');
    assert.deepEqual(await ids('includeFiltered=true&workplace=onsite'), sorted(old, elsewhere));
    assert.equal((await a.call('GET', '/me/jobs?type=freelance')).status, 400);

    const f = (await a.call('GET', '/me/jobs/facets?minScore=40')).body;
    assert.equal(f.total_open, 4);
    assert.equal(f.filtered_out, 1, 'Tokyo on-site is outside preferred locations');
    assert.equal(f.sources, 4);
    assert.equal(f.profile_incomplete, false);
    assert.deepEqual(f.workplace.map((x: any) => x.value).sort(), ['hybrid', 'onsite', 'remote']);
  });

  test('country and city filters, and a Germany preference', async () => {
    const a = await h.user();
    await a.call('PUT', '/me/preferences', {
      titles: ['Engineer'], keywords: [], locations: ['Germany'], remote_ok: true, salary_floor: null,
      excluded_companies: [], excluded_keywords: [], min_score: 0,
    });
    const { jobId: stuttgart } = await h.seedJob([a], { workplace: 'onsite', location: 'Stuttgart, BW, Germany' });
    const { jobId: hamburg } = await h.seedJob([a], { workplace: 'hybrid', location: 'Hamburg' });
    const { jobId: euRemote } = await h.seedJob([a], { location: 'Remote - European Union' });
    const { jobId: usRemote } = await h.seedJob([a], { location: 'Remote - US' });
    const { jobId: amsterdam } = await h.seedJob([a], { workplace: 'onsite', location: 'Amsterdam, Netherlands' });
    await a.call('POST', '/me/sources/sync');

    const ids = async (qs: string) => (await a.call('GET', `/me/jobs?minScore=0&${qs}`)).body.map((j: any) => j.id).sort();
    const sorted = (...x: string[]) => x.sort();
    assert.deepEqual(await ids(''), sorted(stuttgart, hamburg, euRemote), 'US-only remote and Amsterdam are outside Germany');
    assert.deepEqual(await ids('includeFiltered=true&country=DE'), sorted(stuttgart, hamburg, euRemote), 'Germany includes Europe-wide jobs');
    assert.deepEqual(await ids('includeFiltered=true&country=US'), [usRemote]);
    assert.deepEqual(await ids('includeFiltered=true&country=NL,US'), sorted(amsterdam, usRemote, euRemote));
    assert.deepEqual(await ids('location=hamburg'), [hamburg]);
    assert.equal((await a.call('GET', '/me/jobs?country=Germany')).status, 400);

    const f = (await a.call('GET', '/me/jobs/facets?minScore=0')).body;
    assert.deepEqual(f.country.map((c: any) => c.value).sort(), ['DE', 'EU']);
  });

  test('facets explain an empty result for a new account', async () => {
    const a = await h.user();
    let f = (await a.call('GET', '/me/jobs/facets')).body;
    assert.equal(f.sources, 0);
    assert.equal(f.profile_incomplete, true);
    await h.seedJob([a], { workplace: 'onsite', location: 'Hamburg' });
    await a.call('POST', '/me/sources/sync');
    f = (await a.call('GET', '/me/jobs/facets?minScore=40')).body;
    assert.equal(f.total_open, 1);
    assert.equal(f.below_score, 1, 'with an empty profile an on-site job scores 30, below the default minimum of 40');
    assert.deepEqual((await a.call('GET', '/me/jobs?minScore=40')).body, []);
  });
});

async function loginCookie(u: TestUser): Promise<string> {
  const r = await fetch(`${h.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'job-agent' },
    body: JSON.stringify({ email: u.email, password: 'correct-horse-battery' }),
  });
  return r.headers.get('set-cookie')!.split(';')[0];
}

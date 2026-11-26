import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Harness } from './helpers';

const h = new Harness();
before(() => h.start());
after(() => h.stop());

test('saved links can be edited only by users with workspace access', async () => {
  const owner = await h.user();
  const outsider = await h.user();
  const route = '/me/gmail/jobs/manual';
  const job = { url: 'https://example.test/jobs/123', title: 'Engineer' };
  assert.equal((await owner.call('POST', route, { ...job, url: 'javascript:alert(1)' })).status, 400);
  const created = await owner.call('POST', route, job);
  assert.equal(created.status, 201);
  assert.equal((await owner.call('POST', route, job)).status, 409);

  const editRoute = route + '/' + created.body.external_id;
  const edited = { url: 'https://example.test/jobs/456', title: 'Senior Engineer', company: 'Example' };
  assert.equal((await outsider.call('PATCH', editRoute, { ...edited, workspace: owner.id })).status, 404);
  assert.equal((await outsider.call('POST', route, { ...edited, workspace: owner.id })).status, 404);
  assert.equal((await owner.call('PATCH', editRoute, edited)).status, 200);
  const [saved] = (await owner.call('GET', '/me/gmail/jobs?provider=manual')).body;
  assert.equal(saved.url, edited.url);
  assert.equal(saved.title, edited.title);
  assert.equal(saved.company, edited.company);
  assert.equal(saved.status, 'pending');
});

test('an invitation grants access to shared Gmail jobs and resumes until revoked', async () => {
  const owner = await h.user();
  const delegate = await h.user();
  const outsider = await h.user();
  await h.owner.query(
    "insert into gmail_alert_jobs (user_id, external_id, title, received_at) values ($1, '123', 'Developer', now())",
    [owner.id],
  );
  await h.owner.query(
    "insert into resume_builder_documents (owner_id,id,data,updated_at) values ($1,'cv','{\"id\":\"cv\"}',1)",
    [owner.id],
  );
  const invite = await owner.call('POST', '/me/workspaces/invites', { email: delegate.email });
  assert.equal(invite.status, 201);
  assert.equal((await outsider.call('POST', '/me/workspaces/accept', { token: invite.body.token })).status, 409);
  assert.equal((await delegate.call('POST', '/me/workspaces/accept', { token: invite.body.token })).status, 201);
  assert.equal((await delegate.call('POST', '/me/workspaces/accept', { token: invite.body.token })).status, 409);
  await h.owner.query(
    "insert into private_interviews (user_id, message_id, subject, sender, received_at) values ($1, 'private123', 'Interview', 'Recruiter', now())",
    [owner.id],
  );
  const interviews = '/me/gmail/interviews';
  const result = { company: 'Example', job_title: 'Developer', stage: 'second', outcome: 'rejected' };
  assert.deepEqual((await delegate.call('GET', interviews + '?workspace=' + owner.id)).body, []);
  assert.equal((await delegate.call('PATCH', interviews + '/private123', { ...result, workspace: owner.id })).status, 404);
  assert.equal((await owner.call('PATCH', interviews + '/private123', result)).status, 200);
  assert.equal((await owner.call('GET', interviews)).body[0].stage, 'second');
  const jobs = '/me/gmail/jobs?workspace=' + owner.id;
  const activity = '/me/gmail/jobs/activity?workspace=' + owner.id;
  const docs = '/me/resume-builder/' + owner.id + '/docs';
  assert.equal((await delegate.call('GET', jobs)).body[0].title, 'Developer');
  assert.deepEqual((await outsider.call('GET', jobs)).body, []);
  assert.deepEqual((await delegate.call('GET', docs)).body.docs, [{ id: 'cv' }]);
  assert.deepEqual((await delegate.call('GET', '/me/resume-builder/personal/docs')).body.docs, []);
  assert.equal((await outsider.call('GET', docs)).status, 400);
  const unfit = { provider: 'linkedin', status: 'unfit', workspace: owner.id };
  assert.equal((await delegate.call('PATCH', '/me/gmail/jobs/123/status', unfit)).body.status, 'unfit');
  assert.equal((await owner.call('PATCH', '/me/gmail/jobs/123/status', { ...unfit, status: 'viewed' })).body.status, 'unfit');
  const [unfitJob] = (await owner.call('GET', '/me/gmail/jobs')).body;
  assert.equal(unfitJob.status, 'unfit');
  assert.equal(unfitJob.status_actor, delegate.email);
  const status = { provider: 'linkedin', status: 'applied', workspace: owner.id };
  assert.equal((await delegate.call('PATCH', '/me/gmail/jobs/123/status', status)).status, 200);
  assert.equal((await owner.call('GET', '/me/gmail/jobs')).body[0].status_actor, delegate.email);
  for (const viewer of [owner, delegate, delegate]) {
    const opened = await viewer.call('PATCH', '/me/gmail/jobs/123/status', { ...status, status: 'viewed' });
    assert.equal(opened.body.status, 'applied');
  }
  const [viewedJob] = (await delegate.call('GET', jobs)).body;
  assert.equal(viewedJob.status_actor, delegate.email);
  assert.deepEqual(viewedJob.viewers.map((view: { email: string }) => view.email).sort(),
    [owner.email, delegate.email].sort());
  assert.ok(viewedJob.viewers.every((view: { viewed_at: string }) => Number.isFinite(Date.parse(view.viewed_at))));
  await h.owner.query(
    "insert into gmail_alert_jobs (user_id, provider, external_id, received_at) values ($1, 'indeed', '456', now())",
    [owner.id],
  );
  const { body: chart } = await delegate.call('GET', activity);
  assert.deepEqual(chart.totals.sort((a: { status: string }, b: { status: string }) => a.status.localeCompare(b.status)), [
    { status: 'applied', count: 1 },
    { status: 'pending', count: 1 },
  ]);
  assert.equal(chart.daily.length, 14);
  assert.deepEqual(chart.daily.map((day: { count: number }) => day.count), [...Array(13).fill(0), 1]);
  assert.deepEqual((await outsider.call('GET', activity)).body.totals, []);
  const statusRoute = '/me/gmail/jobs/123/status';
  assert.equal((await delegate.call('PATCH', statusRoute, { ...status, status: 'interviewed' })).body.status, 'interviewed');
  assert.equal((await owner.call('PATCH', statusRoute, { ...status, status: 'viewed' })).body.status, 'interviewed');
  const [interviewed] = (await delegate.call('GET', jobs)).body;
  assert.equal(interviewed.status_actor, delegate.email);
  assert.ok((await owner.call('GET', '/me/gmail/jobs/activity')).body.totals
    .some((total: { status: string; count: number }) => total.status === 'interviewed' && total.count === 1));
  await owner.call('DELETE', '/me/workspaces/delegates/' + delegate.id);
  assert.deepEqual((await delegate.call('GET', activity)).body.totals, []);
  assert.deepEqual((await delegate.call('GET', jobs)).body, []);
  assert.equal((await delegate.call('GET', docs)).status, 400);
  assert.equal((await delegate.call('PATCH', '/me/gmail/jobs/123/status', status)).status, 404);
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Harness } from './helpers';

const h = new Harness();
before(() => h.start());
after(() => h.stop());

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
  await owner.call('DELETE', '/me/workspaces/delegates/' + delegate.id);
  assert.deepEqual((await delegate.call('GET', activity)).body.totals, []);
  assert.deepEqual((await delegate.call('GET', jobs)).body, []);
  assert.equal((await delegate.call('GET', docs)).status, 400);
  assert.equal((await delegate.call('PATCH', '/me/gmail/jobs/123/status', status)).status, 404);
});

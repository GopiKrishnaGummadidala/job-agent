import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssessment } from '../src/ai/prompts';
import { draftHash } from '../src/drafts';
import { hasTerm, scoreJob, tagMatches } from '../src/matching/score';
import { recommendResume } from '../src/resumes';
import { htmlToText, parseBoardRef } from '../src/sources/adapters';

const prefs = {
  titles: ['Backend Engineer'],
  keywords: [],
  locations: ['Berlin'],
  remote_ok: true,
  excluded_companies: ['BadCorp'],
  excluded_keywords: ['Intern'],
};
const job = { company: 'Acme', title: 'Senior Backend Engineer', location: 'Berlin, Germany', remote: false, description: 'C# and .NET with PostgreSQL' };

test('hasTerm matches whole terms including symbols', () => {
  assert.ok(hasTerm('We use C# and .NET', 'C#'));
  assert.ok(hasTerm('We use C# and .NET', '.net'));
  assert.ok(!hasTerm('JavaScript developer', 'Java'));
  assert.ok(!hasTerm('Golang', 'Go'));
});

test('scoreJob ranks a strong match highly and explains why', () => {
  const r = scoreJob(job, { skills: ['C#', '.NET', 'PostgreSQL'] }, prefs);
  assert.equal(r.filtered, false);
  assert.equal(r.score, 100);
  assert.deepEqual(r.reasons.map((x) => x.label), ['Location', 'Role', 'Skills']);
});

test('scoreJob filters exclusions and wrong locations', () => {
  assert.equal(scoreJob({ ...job, company: 'BadCorp GmbH' }, { skills: [] }, prefs).filtered, true);
  assert.equal(scoreJob({ ...job, title: 'Backend Engineer Intern' }, { skills: [] }, prefs).filtered, true);
  assert.equal(scoreJob({ ...job, location: 'Tokyo' }, { skills: [] }, prefs).filtered, true);
  assert.equal(scoreJob({ ...job, location: 'Tokyo', remote: true }, { skills: [] }, prefs).filtered, false);
});

test('parseBoardRef accepts URLs and tokens', () => {
  assert.deepEqual(parseBoardRef('https://job-boards.greenhouse.io/gitlab/jobs/123'), { kind: 'greenhouse', token: 'gitlab' });
  assert.deepEqual(parseBoardRef('https://jobs.lever.co/acme'), { kind: 'lever', token: 'acme' });
  assert.deepEqual(parseBoardRef('https://jobs.ashbyhq.com/ramp/abc'), { kind: 'ashby', token: 'ramp' });
  assert.deepEqual(parseBoardRef('acme', 'lever'), { kind: 'lever', token: 'acme' });
  assert.equal(parseBoardRef('../etc/passwd', 'lever'), null);
  assert.equal(parseBoardRef('https://evil.example/whatever'), null);
});

test('htmlToText strips markup and scripts', () => {
  assert.equal(htmlToText('<p>Hello &amp; welcome</p><script>alert(1)</script><ul><li>Go</li></ul>'), 'Hello & welcome\n- Go');
});

test('recommendResume picks the resume covering most job skills and lists gaps', () => {
  const r = recommendResume(
    [
      { id: 'a', filename: 'a.pdf', extracted_text: 'React developer' },
      { id: 'b', filename: 'b.pdf', extracted_text: 'C# .NET services' },
    ],
    ['C#', '.NET', 'PostgreSQL', 'React'],
    job.description,
  );
  assert.equal(r.resumeId, 'b');
  assert.deepEqual(r.missing, ['PostgreSQL']);
});

test('tagMatches understands common spellings', () => {
  assert.ok(tagMatches('Experience with C# required', '.NET'));
  assert.ok(tagMatches('We use Node.js', 'node'));
  assert.ok(tagMatches('Angular 18 frontend', 'Angular'));
  assert.ok(!tagMatches('React frontend', 'Angular'));
  assert.ok(tagMatches('Terraform and Azure', 'Azure'), 'unknown tags match as written');
});

test('recommendResume prefers a CV whose tags the job mentions', () => {
  const r = recommendResume(
    [
      { id: 'node', filename: 'node.pdf', extracted_text: 'C# .NET Node PostgreSQL', tags: ['Node'] },
      { id: 'dotnet', filename: 'dotnet.pdf', extracted_text: 'C#', tags: ['.NET'] },
    ],
    ['C#', '.NET', 'PostgreSQL'],
    job.description,
  );
  assert.equal(r.resumeId, 'dotnet');
  assert.deepEqual(r.tagHits, ['.NET']);
});

test('draftHash changes when submitted content changes', () => {
  const base = { job_id: 'j', apply_url: 'u', resume_sha256: 's', cover_letter: 'x', answers: [] };
  assert.equal(draftHash(base), draftHash({ ...base }));
  assert.notEqual(draftHash(base), draftHash({ ...base, cover_letter: 'y' }));
  assert.notEqual(draftHash(base), draftHash({ ...base, resume_sha256: 't' }));
});

test('parseAssessment tolerates prose around JSON and clamps scores', () => {
  const a = parseAssessment('Sure: {"score": 140, "summary": "ok", "gaps": ["Go"]} done');
  assert.equal(a?.score, 100);
  assert.deepEqual(a?.gaps, ['Go']);
  assert.equal(parseAssessment('no json'), null);
});

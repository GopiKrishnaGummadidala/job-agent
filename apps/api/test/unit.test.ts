import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssessment } from '../src/ai/prompts';
import { draftHash } from '../src/drafts';
import { hasTerm, scoreJob, tagMatches } from '../src/matching/score';
import { recommendResume } from '../src/resumes';
import { boardRefHelp, htmlToText, parseBoardRef, parsePersonioXml } from '../src/sources/adapters';

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
  assert.equal(scoreJob({ ...job, location: 'Remote', remote: true }, { skills: [] }, prefs).filtered, false);
});

test('a country preference covers its cities and Europe-wide remote jobs, not remote jobs elsewhere', () => {
  const de = { ...prefs, locations: ['Germany'] };
  const score = (location: string, remote = false) => scoreJob({ ...job, location, remote }, { skills: [] }, de);
  assert.match(score('Göttingen').reasons[0].detail, /In Germany/);
  assert.equal(score('Stuttgart, BW, Germany').filtered, false);
  assert.match(score('Remote - European Union', true).reasons[0].detail, /Remote, open to Germany/);
  assert.equal(score('Remote, Germany', true).filtered, false);
  assert.equal(score('Remote', true).filtered, false, 'remote without a stated country is kept');
  assert.equal(score('Remote - US', true).filtered, true);
  assert.equal(score('Remote, Canada; Remote, United States', true).filtered, true);
  assert.equal(score('Amsterdam, Netherlands').filtered, true);
  assert.equal(scoreJob({ ...job, location: 'Remote', remote: true, countries: ['DE'] }, { skills: [] }, de).filtered, false);
});

test('parseBoardRef accepts URLs and tokens', () => {
  assert.deepEqual(parseBoardRef('https://job-boards.greenhouse.io/gitlab/jobs/123'), { kind: 'greenhouse', token: 'gitlab' });
  assert.deepEqual(parseBoardRef('https://jobs.lever.co/acme'), { kind: 'lever', token: 'acme' });
  assert.deepEqual(parseBoardRef('https://jobs.ashbyhq.com/ramp/abc'), { kind: 'ashby', token: 'ramp' });
  assert.deepEqual(parseBoardRef('acme', 'lever'), { kind: 'lever', token: 'acme' });
  assert.equal(parseBoardRef('../etc/passwd', 'lever'), null);
  assert.equal(parseBoardRef('https://evil.example/whatever'), null);
});

test('boardRefHelp explains vendor homepages, other sites and bare tokens', () => {
  assert.equal(parseBoardRef('https://www.ashbyhq.com/'), null);
  assert.match(boardRefHelp('https://www.ashbyhq.com/'), /Ashby's own website.*jobs\.ashbyhq\.com\/<company>.*jobs\.ashbyhq\.com\/ashby/);
  assert.match(boardRefHelp('greenhouse.com'), /Greenhouse's own website.*job-boards\.greenhouse\.io\/<company>/);
  assert.match(boardRefHelp('https://www.lever.co/pricing'), /Lever's own website/);
  assert.match(boardRefHelp('https://careers.example.com/jobs'), /careers.example.com is not a supported job board.*Personio.*Workday/);
  assert.match(boardRefHelp('gitlab'), /Choose the board type/);
  assert.match(boardRefHelp('bad token!', 'lever'), /may only contain/);
});

test('parseBoardRef recognises Personio, Recruitee, Workable and SmartRecruiters addresses', () => {
  assert.deepEqual(parseBoardRef('https://1komma5grad.jobs.personio.de/job/2800938?language=en'), { kind: 'personio', token: '1komma5grad' });
  assert.deepEqual(parseBoardRef('acme.jobs.personio.com'), { kind: 'personio', token: 'acme' });
  assert.deepEqual(parseBoardRef('https://bunq.recruitee.com/o/some-job'), { kind: 'recruitee', token: 'bunq' });
  assert.deepEqual(parseBoardRef('https://apply.workable.com/huggingface/'), { kind: 'workable', token: 'huggingface' });
  assert.equal(parseBoardRef('https://apply.workable.com/j/81B46579FE'), null, 'a Workable /j/ link has no company name');
  assert.deepEqual(parseBoardRef('https://jobs.smartrecruiters.com/BoschGroup/7440001'), { kind: 'smartrecruiters', token: 'BoschGroup' });
  assert.equal(parseBoardRef('https://www.recruitee.com/'), null);
  assert.match(boardRefHelp('https://www.personio.de/'), /Personio's own website.*<company>\.jobs\.personio\.de/);
  assert.deepEqual(parseBoardRef('acme', 'smartrecruiters'), { kind: 'smartrecruiters', token: 'acme' });
});

test('parsePersonioXml reads positions, offices, descriptions and labels', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
  <id>42</id>
  <office>Hamburg</office>
  <additionalOffices><office>Berlin (Remote)</office><office>Hamburg</office></additionalOffices>
  <name>Backend Developer .NET (m/w/d) &amp; Cloud</name>
  <jobDescriptions>
    <jobDescription><name>Your tasks</name><value><![CDATA[<p>Build <b>C#</b> services</p>]]></value></jobDescription>
  </jobDescriptions>
  <employmentType>permanent</employmentType>
  <seniority>entry-level</seniority>
  <schedule>part-time</schedule>
  <keywords>dotnet,azure</keywords>
  <createdAt>2026-11-01T08:00:00+00:00</createdAt>
</position>
<position>
  <id>43</id>
  <office>Munich</office>
  <name>Werkstudent Data (m/w/d)</name>
  <jobDescriptions></jobDescriptions>
  <employmentType>working_student</employmentType>
  <seniority>student</seniority>
  <schedule>part-time</schedule>
</position>
</workzag-jobs>`;
  const [a, b] = parsePersonioXml(xml, 'acme-gmbh');
  assert.equal(a.title, 'Backend Developer .NET (m/w/d) & Cloud');
  assert.equal(a.company, 'Acme Gmbh');
  assert.equal(a.location, 'Hamburg, Berlin (Remote)');
  assert.equal(a.employment_type, 'part_time');
  assert.equal(a.seniority, 'junior');
  assert.match(a.description, /Your tasks\nBuild C# services/);
  assert.match(a.description, /Keywords: dotnet,azure/);
  assert.equal(a.url, 'https://acme-gmbh.jobs.personio.de/job/42?language=en');
  assert.equal(a.posted_at, '2026-11-01T08:00:00.000Z');
  assert.equal(b.employment_type, 'working_student');
  assert.equal(b.seniority, 'intern');
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

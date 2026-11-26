import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseAlert, parseLinkedInAlert } from '../src/gmail-alerts';

test('Indeed Match cards decode a job destination and ignore preference links', () => {
  const wrap = (u: string, aggJobId: string) =>
    'https://cts.indeed.com/v3/' + gzipSync(JSON.stringify({ u, m: { aggJobId } })).toString('base64url') + '/signature';
  const target = wrap('https://de.indeed.com/pagead/clk?ad=example-token&rm=1&xkcb=tracking', '123456789');
  const html = `<a href="${target}">Job als Engineer anzeigen</a>
    <a href="${target}">Change preferences</a>
    <a href="${wrap('https://example.test/pagead/clk?ad=x', '999')}">View job</a>`;
  assert.deepEqual(parseAlert(html, '', 'indeed', 'Engineer bei Example GmbH'), [{
    externalId: 'ad-123456789', url: 'https://de.indeed.com/pagead/clk?ad=example-token&rm=1',
    title: 'Engineer', company: 'Example GmbH',
  }]);
});

test('LinkedIn alerts yield separate jobs with tracking stripped and repeated links merged', () => {
  const html = [
    '<a href="https://www.linkedin.com/comm/jobs/view/123/?trackingId=abc">View job</a>',
    '<a href="https://www.linkedin.com/jobs/view/software-engineer-123?refId=abc&amp;other=1"><span>Software Engineer</span></a>',
    "<a href='https://linkedin.com/jobs/view/456'>Frontend Engineer</a>",
    '<a href="https://linkedin.com.example.test/jobs/view/789">Unrelated site</a>',
  ].join('');
  const text = 'See https://www.linkedin.com/jobs/view/456 or https://www.linkedin.com/comm/jobs/view/999.';
  assert.deepEqual(parseLinkedInAlert(html, text), [
    { externalId: '123', url: 'https://www.linkedin.com/jobs/view/123/', title: 'Software Engineer' },
    { externalId: '456', url: 'https://www.linkedin.com/jobs/view/456/', title: 'Frontend Engineer' },
    { externalId: '999', url: 'https://www.linkedin.com/jobs/view/999/', title: null },
  ]);
});

test('Indeed and Glassdoor alerts extract provider-specific job IDs', () => {
  const indeed = '<a href="https://de.indeed.com/rc/clk/dl?jk=abcdef1234567890">Software Engineer</a>';
  const glassdoor = '<a href="https://www.glassdoor.com/partner/jobListing.htm?jobListingId=12345">Developer</a>';
  assert.deepEqual(parseAlert(indeed + glassdoor, '', 'indeed').map(job => job.externalId), ['abcdef1234567890']);
  assert.deepEqual(parseAlert(indeed + glassdoor, '', 'glassdoor').map(job => job.externalId), ['12345']);
  assert.deepEqual(parseAlert('<a href="https://glassdoor.com.example.org/partner/jobListing.htm?jobListingId=1">Fake</a>', '', 'glassdoor'), []);
});

test('Indeed digest reads the employer paragraph before the location', () => {
  const html = '<h2><a href="https://de.indeed.com/rc/clk/dl?jk=abcdef1234567890">Engineer</a></h2>'
    + '</td></tr><tr><td><table><tr><td><p>Acme &amp; Co</p></td></tr>'
    + '<tr><td><p>Hamburg</p></td></tr></table>';
  assert.equal(parseAlert(html, '', 'indeed')[0].company, 'Acme & Co');
});

test('Glassdoor digest separates the rated employer from the title', () => {
  const html = '<a href="https://www.glassdoor.com/partner/jobListing.htm?jobListingId=12345">'
    + '<p>Acme&nbsp;4.2 ★</p><p>Senior Engineer</p><p>Hamburg</p></a>';
  const [job] = parseAlert(html, '', 'glassdoor');
  assert.equal(job.company, 'Acme');
  assert.equal(job.title, 'Senior Engineer');
});

test('Glassdoor full cards can have an employer without a rating', () => {
  const html = '<a href="https://www.glassdoor.com/partner/jobListing.htm?jobListingId=12345">'
    + '<table><tr><td><p>Acme</p><p>Senior Engineer</p><p>Hamburg</p><p>6T</p></td></tr></table></a>';
  assert.equal(parseAlert(html, '', 'glassdoor')[0].company, 'Acme');
});

test('employer labels stay with the corresponding job', () => {
  const html = '<a href="https://www.linkedin.com/jobs/view/123">Engineer</a>'
    + '<span class="company-name">Acme &amp; Co</span>'
    + '<a href="https://www.linkedin.com/jobs/view/456">Developer</a>';
  const jobs = parseLinkedInAlert(html, '');
  assert.equal(jobs[0].company, 'Acme & Co');
  assert.equal(jobs[1].company, undefined);
});

test('LinkedIn alert company is the first part of the company and location line', () => {
  const html = '<a href="https://www.linkedin.com/comm/jobs/view/123">Engineer</a></td></tr>'
    + '<tr><td class="pb-0"><p class="text-xs line-clamp-1">Acme &amp; Co &middot; Berlin (Hybrid)</p>';
  assert.equal(parseLinkedInAlert(html, '')[0].company, 'Acme & Co');
});

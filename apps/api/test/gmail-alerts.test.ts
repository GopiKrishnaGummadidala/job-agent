import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinkedInAlert } from '../src/gmail-alerts';

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

test('Indeed and Glassdoor alerts extract provider-specific job IDs', async () => {
  const { parseAlert } = await import('../src/gmail-alerts.js');
  const indeed = '<a href="https://de.indeed.com/rc/clk/dl?jk=abcdef1234567890">Software Engineer</a>';
  const glassdoor = '<a href="https://www.glassdoor.com/partner/jobListing.htm?jobListingId=12345">Developer</a>';
  assert.deepEqual(parseAlert(indeed + glassdoor, '', 'indeed').map(job => job.externalId), ['abcdef1234567890']);
  assert.deepEqual(parseAlert(indeed + glassdoor, '', 'glassdoor').map(job => job.externalId), ['12345']);
  assert.deepEqual(parseAlert('<a href="https://glassdoor.com.example.org/partner/jobListing.htm?jobListingId=1">Fake</a>', '', 'glassdoor'), []);
});

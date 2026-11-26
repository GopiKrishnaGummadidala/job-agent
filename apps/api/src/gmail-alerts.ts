import { gunzipSync } from 'node:zlib';
import { htmlToText } from './sources/adapters';

export interface LinkedInAlertJob {
  externalId: string;
  url: string;
  title: string | null;
  company?: string;
}

export const providers = ['linkedin', 'indeed', 'glassdoor'] as const;
export type Provider = typeof providers[number];

export const alertSenders: Record<Provider, string> = {
  linkedin: '{from:jobalerts-noreply@linkedin.com from:jobs-noreply@linkedin.com}',
  indeed: '{from:donotreply@match.indeed.com from:indeed.com from:indeedmail.com from:indeed.de from:indeed.co.uk from:indeed.fr from:indeed.ca from:indeed.nl from:indeed.ie from:indeed.com.au}',
  glassdoor: 'from:glassdoor.com',
};

export function jobLink(provider: Provider, id: string): string {
  if (provider === 'indeed') return 'https://www.indeed.com/viewjob?jk=' + encodeURIComponent(id);
  if (provider === 'glassdoor') return 'https://www.glassdoor.com/partner/jobListing.htm?jobListingId=' + encodeURIComponent(id);
  return 'https://www.linkedin.com/jobs/view/' + encodeURIComponent(id) + '/';
}

function jobId(href: string, provider: Provider): string | null {
  try {
    const url = new URL(href.replace(/&amp;/gi, '&'));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (provider === 'indeed') {
      if (!/^(?:[a-z-]+\.)?indeed\.(com|de|co\.uk|fr|ca|nl|ie|com\.au)$/.test(url.hostname)) return null;
      if (!/^\/(viewjob|rc\/clk(?:\/dl)?|pagead\/clk|m\/basecamp\/viewjob)\/?$/.test(url.pathname)) return null;
      const id = url.searchParams.get('jk') ?? url.searchParams.get('vjk');
      return id && /^[a-f0-9]{16}$/i.test(id) ? id.toLowerCase() : null;
    }
    if (provider === 'glassdoor') {
      if (!/^(?:www\.)?glassdoor\.(com|de|co\.uk|fr|ca|nl|ie|com\.au)$/.test(url.hostname)) return null;
      if (!/^\/(job-listing\/[^/]+|partner\/jobListing)\.htm$/i.test(url.pathname)) return null;
      const id = url.searchParams.get('jl') ?? url.searchParams.get('jobListingId');
      return id && /^\d{1,24}$/.test(id) ? id : null;
    }
    if (!['www.linkedin.com', 'linkedin.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d+)\/?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function indeedRecommendation(href: string, label: string) {
  try {
    const wrapper = new URL(href);
    if (wrapper.origin !== 'https://cts.indeed.com' || wrapper.username || wrapper.password) return null;
    const token = /^\/v3\/([\w-]{1,8192})\/[\w-]+$/.exec(wrapper.pathname)?.[1];
    if (!token) return null;
    const payload = JSON.parse(gunzipSync(Buffer.from(token, 'base64url'), { maxOutputLength: 16_384 }).toString());
    if (typeof payload?.u !== 'string') return null;
    const ordinaryId = jobId(payload.u, 'indeed');
    if (ordinaryId) return { id: ordinaryId, url: jobLink('indeed', ordinaryId) };
    const target = new URL(payload.u);
    if (target.protocol !== 'https:' || target.username || target.password || target.port
      || !/^(?:[a-z-]+\.)?indeed\.(com|de|co\.uk|fr|ca|nl|ie|com\.au)$/.test(target.hostname)
      || target.pathname !== '/pagead/clk' || !/^[\w%+=/-]{1,2048}$/.test(target.searchParams.get('ad') ?? '')
      || typeof payload.m?.aggJobId !== 'string' || !/^\d{1,20}$/.test(payload.m.aggJobId)
      || !/^(?:job als .+ anzeigen|view (?:this )?job|view job .+)$/i.test(label)) return null;
    const url = new URL(target.pathname, target.origin);
    for (const key of ['ad', 'mo', 'rm']) {
      const value = target.searchParams.get(key);
      if (value) url.searchParams.set(key, value);
    }
    return { id: 'ad-' + payload.m.aggJobId, url: url.href };
  } catch {
    return null;
  }
}

/** Collect direct job links without following redirects or loading remote content. */
export function parseAlert(html: string, plainText: string, provider: Provider, subject = ''): LinkedInAlertJob[] {
  const jobs = new Map<string, LinkedInAlertJob>();
  const collect = (href: string, label = '', company?: string) => {
    const recommendation = provider === 'indeed' ? indeedRecommendation(href, htmlToText(label).trim()) : null;
    const externalId = recommendation?.id ?? jobId(href, provider);
    if (!externalId) return;
    const raw = htmlToText(label);
    const lines = raw.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // Glassdoor links wrap the full card, including a rated employer line and the title below it.
    const ratedEmployer = provider === 'glassdoor' && lines.length >= 3
      ? lines[0].match(/^(.+?)\s*\d[.,]\d\s*★$/)?.[1]?.trim()
      : undefined;
    const unratedEmployer = provider === 'glassdoor' && lines.length >= 4
      && /<table\b/i.test(label) && /^(?:\d{1,3}\s*[a-z]{1,3}|30\+)$/i.test(lines.at(-1) ?? '')
      ? lines[0]
      : undefined;
    const glassdoorEmployer = ratedEmployer || unratedEmployer;
    const text = glassdoorEmployer ? lines[1] : raw.replace(/\s+/g, ' ').trim();
    const title = !text || /^(view|see|apply(?: now)?|view job|see job|view details|job details)$/i.test(text)
      ? null
      : text.slice(0, 250);
    const previous = jobs.get(externalId);
    const employer = previous?.company ?? company ?? glassdoorEmployer?.slice(0, 200);
    const subjectParts = recommendation ? subject.match(/^(.+?)\s+(?:bei|at)\s+(.+)$/i) : null;
    const recommendationCompany = subjectParts?.[2].trim().slice(0, 200);
    jobs.set(externalId, {
      externalId, url: recommendation?.url ?? jobLink(provider, externalId), title: previous?.title ?? subjectParts?.[1].trim().slice(0, 250) ?? title,
      ...(employer || recommendationCompany ? { company: employer ?? recommendationCompany } : {}),
    });
  };

  const links = [...html.matchAll(
    /<a\b[^>]*?\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
  )].filter(([, quoted, singleQuoted, unquoted, label]) => {
    const href = quoted ?? singleQuoted ?? unquoted;
    return jobId(href, provider) || (provider === 'indeed' && indeedRecommendation(href, htmlToText(label).trim()));
  });
  for (const [index, link] of links.entries()) {
    const [anchor, quoted, singleQuoted, unquoted, label] = link;
    // Employer metadata belongs to the current job card, before the next job link.
    const start = link.index + anchor.length;
    const next = html.slice(start, Math.min(start + 3000, links[index + 1]?.index ?? html.length));
    const employer = next.match(/<(div|span|p|td)\b[^>]*(?:data-testid|class|itemprop)\s*=\s*["'][^"']*(?:company[-_ ]?name|hiringOrganization|job[-_ ]?company|employer[-_ ]?name)[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2];
    const linkedInLine = provider === 'linkedin'
      ? next.match(/^\s*(?:<\/?(?:td|tr|p|div|span)\b[^>]*>\s*){0,8}?<(p|div|span)\b[^>]*\bclass=["'][^"']*line-clamp-1[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2]
      : undefined;
    const linkedInParts = linkedInLine?.split(/\s*(?:&middot;|&#183;|&#x0*b7;|[·•])\s*/i);
    // Indeed's digest nests the company and location in the first two paragraphs after the title heading.
    const indeedLine = provider === 'indeed' && /^\s*<\/h2>/i.test(next)
      ? next.match(/^\s*<\/h2>(?:\s*<[^>]+>){0,28}?\s*<p\b[^>]*>([^<>]+)<\/p>(?:\s*<[^>]+>){0,20}?\s*<p\b[^>]*>[^<>]+<\/p>/i)?.[1]
      : undefined;
    const source = employer ?? indeedLine ?? (linkedInParts && linkedInParts.length > 1 ? linkedInParts[0] : undefined);
    const company = source && htmlToText(source).replace(/\s+/g, ' ').trim().slice(0, 200);
    collect(quoted ?? singleQuoted ?? unquoted, label, company || undefined);
  }
  for (const [url] of plainText.matchAll(/https:\/\/[^\s<>"]+/gi)) collect(url.replace(/[).,]+$/, ''));
  return [...jobs.values()];
}

export const parseLinkedInAlert = (html: string, text: string) => parseAlert(html, text, 'linkedin');

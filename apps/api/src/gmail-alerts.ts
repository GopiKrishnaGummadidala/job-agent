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
  indeed: '{from:indeed.com from:indeedmail.com}',
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

/** Collect direct job links without following redirects or loading remote content. */
export function parseAlert(html: string, plainText: string, provider: Provider): LinkedInAlertJob[] {
  const jobs = new Map<string, LinkedInAlertJob>();
  const collect = (href: string, label = '', company?: string) => {
    const externalId = jobId(href, provider);
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
    jobs.set(externalId, {
      externalId, url: jobLink(provider, externalId), title: previous?.title ?? title,
      ...(employer ? { company: employer } : {}),
    });
  };

  const links = [...html.matchAll(
    /<a\b[^>]*?\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
  )].filter(([, quoted, singleQuoted, unquoted]) => jobId(quoted ?? singleQuoted ?? unquoted, provider));
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

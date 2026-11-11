import { createHash } from 'node:crypto';
import {
  employmentFromLabel,
  EmploymentType,
  inferEmployment,
  inferSeniority,
  inferWorkplace,
  Seniority,
  Workplace,
  workplaceFromLabel,
} from './classify';

/** Public, documented job-board endpoints only. No scraping, no authentication, no automation. */

export type BoardKind = 'greenhouse' | 'lever' | 'ashby';

export interface NormalizedJob {
  external_id: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  employment_type: EmploymentType;
  workplace: Workplace;
  seniority: Seniority;
  url: string;
  apply_url: string;
  description: string;
  content_hash: string;
  posted_at: string | null;
}

const TOKEN = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_DESCRIPTION = 20_000;

/** Accepts a board token or a pasted board URL and returns the kind and token. */
export function parseBoardRef(input: string, kind?: BoardKind): { kind: BoardKind; token: string } | null {
  const raw = input.trim();
  const patterns: [BoardKind, RegExp][] = [
    ['greenhouse', /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9._-]+)/i],
    ['lever', /jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9._-]+)/i],
    ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9._-]+)/i],
  ];
  for (const [k, re] of patterns) {
    const m = raw.match(re);
    if (m) return { kind: k, token: m[1] };
  }
  if (kind && TOKEN.test(raw)) return { kind, token: raw };
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>|<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

/** Lever and Ashby do not return a company name; "acme-labs" becomes "Acme Labs". */
const companyFromToken = (token: string) =>
  token.replace(/[-_.]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());

type RawJob = Omit<NormalizedJob, 'content_hash' | 'remote' | 'employment_type' | 'workplace' | 'seniority'> & {
  /** The board's own employment label, e.g. Lever "Full-time" or Ashby "PartTime". */
  employmentLabel?: unknown;
  /** The board's own workplace label, e.g. "hybrid" or "OnSite". */
  workplaceLabel?: unknown;
  /** Used only when the board gives no workplace label. */
  remoteFlag?: boolean;
};

function finish(j: RawJob): NormalizedJob {
  const { employmentLabel, workplaceLabel, remoteFlag, ...rest } = j;
  const description = rest.description.slice(0, MAX_DESCRIPTION);
  const employment_type = employmentFromLabel(employmentLabel) ?? inferEmployment(rest.title, description);
  const workplace =
    workplaceFromLabel(workplaceLabel) ?? (remoteFlag ? 'remote' : inferWorkplace(rest.title, rest.location, description));
  const content_hash = createHash('sha256')
    .update(JSON.stringify([rest.title, rest.location, rest.apply_url, description]))
    .digest('hex');
  return {
    ...rest,
    description,
    remote: workplace === 'remote',
    employment_type,
    workplace,
    seniority: inferSeniority(rest.title, employment_type),
    content_hash,
  };
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'job-agent/0.1' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new Error('Board not found. Check the company token.');
  if (!res.ok) throw new Error(`Job board responded with HTTP ${res.status}.`);
  return res.json();
}

export async function fetchBoard(kind: BoardKind, token: string): Promise<NormalizedJob[]> {
  if (!TOKEN.test(token)) throw new Error('Invalid board token.');
  const t = encodeURIComponent(token);

  if (kind === 'greenhouse') {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`);
    return (data.jobs ?? []).map((j: any) =>
      finish({
        external_id: String(j.id),
        company: j.company_name || token,
        title: String(j.title ?? '').trim(),
        location: j.location?.name ?? '',
        url: j.absolute_url,
        apply_url: j.absolute_url,
        // Greenhouse returns entity-escaped HTML, so decode once before stripping tags.
        description: htmlToText(decodeEntities(String(j.content ?? ''))),
        posted_at: iso(j.first_published ?? j.updated_at),
      }),
    );
  }

  if (kind === 'lever') {
    const data = await getJson(`https://api.lever.co/v0/postings/${t}?mode=json`);
    return (Array.isArray(data) ? data : []).map((j: any) => {
      const lists = (j.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(String(l.content ?? ''))}`);
      return finish({
        external_id: String(j.id),
        company: companyFromToken(token),
        title: String(j.text ?? '').trim(),
        location: j.categories?.location ?? '',
        employmentLabel: j.categories?.commitment,
        workplaceLabel: j.workplaceType,
        url: j.hostedUrl,
        apply_url: j.applyUrl ?? j.hostedUrl,
        description: [j.descriptionPlain, ...lists, j.additionalPlain].filter(Boolean).join('\n\n').trim(),
        posted_at: iso(j.createdAt),
      });
    });
  }

  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${t}`);
  return (data.jobs ?? [])
    .filter((j: any) => j.isListed !== false)
    .map((j: any) =>
      finish({
        external_id: String(j.id),
        company: companyFromToken(token),
        title: String(j.title ?? '').trim(),
        location: j.location ?? '',
        employmentLabel: j.employmentType,
        // Ashby sets isRemote on hybrid jobs too, so its workplaceType wins when present.
        workplaceLabel: j.workplaceType,
        remoteFlag: j.isRemote === true && !j.workplaceType,
        url: j.jobUrl,
        apply_url: j.applyUrl ?? j.jobUrl,
        description: j.descriptionPlain ?? htmlToText(String(j.descriptionHtml ?? '')),
        posted_at: iso(j.publishedAt),
      }),
    );
}

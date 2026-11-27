import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  employmentFromLabel,
  EmploymentType,
  inferEmployment,
  inferSeniority,
  inferWorkplace,
  seniorityFromLabel,
  Seniority,
  Workplace,
  workplaceFromLabel,
} from './classify';

/** Public, documented job-board endpoints only. No scraping, no authentication, no automation. */

export const BOARD_KINDS = ['greenhouse', 'lever', 'ashby', 'personio', 'recruitee', 'workable', 'smartrecruiters', 'arbeitnow'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

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
  /** True when the board was not asked for this posting's description; the stored one is kept. */
  keep_description?: boolean;
}

export interface FetchOptions {
  /**
   * Postings already stored with a description, keyed by external id, valued by their posted date.
   * Boards that need one request per description (SmartRecruiters) skip unchanged ones.
   */
  known?: Map<string, string | null>;
}

const TOKEN = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_DESCRIPTION = 20_000;

interface BoardSystem {
  kind: BoardKind;
  name: string;
  /** Matches a board or job URL and captures the company token. */
  url: RegExp;
  /** The vendor's own website, which is not a board. */
  vendor: RegExp;
  board: string;
}

export const BOARD_SYSTEMS: BoardSystem[] = [
  {
    kind: 'greenhouse',
    name: 'Greenhouse',
    url: /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9._-]+)/i,
    vendor: /(^|\.)greenhouse\.(io|com)$/i,
    board: 'job-boards.greenhouse.io/<company>',
  },
  { kind: 'lever', name: 'Lever', url: /jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9._-]+)/i, vendor: /(^|\.)lever\.co$/i, board: 'jobs.lever.co/<company>' },
  { kind: 'ashby', name: 'Ashby', url: /jobs\.ashbyhq\.com\/([A-Za-z0-9._-]+)/i, vendor: /(^|\.)ashbyhq\.com$/i, board: 'jobs.ashbyhq.com/<company>' },
  {
    kind: 'personio',
    name: 'Personio',
    url: /(?:^|\/\/|\s)([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i,
    vendor: /(^|\.)personio\.(de|com)$/i,
    board: '<company>.jobs.personio.de',
  },
  {
    kind: 'recruitee',
    name: 'Recruitee',
    url: /(?:^|\/\/|\s)([a-z0-9-]+)\.recruitee\.com/i,
    vendor: /(^|\.)recruitee\.com$/i,
    board: '<company>.recruitee.com',
  },
  {
    kind: 'workable',
    name: 'Workable',
    url: /apply\.workable\.com\/(?!j\/|api\/)([A-Za-z0-9_-]+)/i,
    vendor: /(^|\.)workable\.com$/i,
    board: 'apply.workable.com/<company>',
  },
  {
    kind: 'smartrecruiters',
    name: 'SmartRecruiters',
    url: /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i,
    vendor: /(^|\.)smartrecruiters\.com$/i,
    board: 'jobs.smartrecruiters.com/<company>',
  },
  { kind: 'arbeitnow', name: 'Arbeitnow', url: /(?:^|\/\/)(?:www\.)?(arbeitnow)\.com(?:\/|$)/i,
    vendor: /(^|\.)arbeitnow\.com$/i, board: 'www.arbeitnow.com' },
];

const SYSTEM_NAMES = BOARD_SYSTEMS.map((s) => s.name);
const listNames = (names: string[]) => `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

/** Accepts a board token or a pasted board or job URL and returns the kind and token. */
export function parseBoardRef(input: string, kind?: BoardKind): { kind: BoardKind; token: string } | null {
  const raw = input.trim();
  for (const s of BOARD_SYSTEMS) {
    const m = raw.match(s.url);
    // "www.recruitee.com" or "jobs.personio.de" alone are vendor sites, not boards.
    if (m && !/^(www|jobs|app|api|help|support)$/i.test(m[1])) return { kind: s.kind, token: m[1] };
  }
  if (kind === 'arbeitnow') return raw.toLowerCase() === 'arbeitnow' ? { kind, token: 'arbeitnow' } : null;
  if (kind && TOKEN.test(raw)) return { kind, token: raw };
  return null;
}

/** Explains why a pasted value is not a usable board reference, with the address format to use instead. */
export function boardRefHelp(input: string, kind?: BoardKind): string {
  const raw = input.trim();
  let url: URL | null = null;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    url = null;
  }
  const looksLikeUrl = /[./]/.test(raw) && url !== null;
  if (looksLikeUrl && url) {
    const vendor = BOARD_SYSTEMS.find((b) => b.vendor.test(url!.hostname));
    if (vendor) {
      const own = vendor.kind === 'ashby' ? ' For jobs at Ashby itself, use https://jobs.ashbyhq.com/ashby.' : '';
      return (
        `That is ${vendor.name}'s own website, not a company's job board. ` +
        `Each company using ${vendor.name} has a board at ${vendor.board}; the address of one of their job postings works too.${own}`
      );
    }
    return (
      `${url.hostname} is not a supported job board. On the company's careers page, open a job posting and check its address: ` +
      `${listNames(SYSTEM_NAMES)} boards are supported (for example ${BOARD_SYSTEMS.slice(0, 4).map((s) => s.board).join(', ')}). ` +
      'Companies using other systems such as Workday are not supported, because those systems offer no public job feed.'
    );
  }
  if (!kind) return `Choose the board type (${listNames(SYSTEM_NAMES)}) for "${raw}", or paste the board's full address.`;
  return 'A board name may only contain letters, numbers, dots, dashes and underscores, for example "gitlab".';
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

/** For boards that do not return a company name: "acme-labs" becomes "Acme Labs". */
const companyFromToken = (token: string) =>
  token.replace(/[-_.]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());

type RawJob = Omit<NormalizedJob, 'content_hash' | 'remote' | 'employment_type' | 'workplace' | 'seniority'> & {
  /** The board's own employment label, e.g. Lever "Full-time" or Ashby "PartTime". */
  employmentLabel?: unknown;
  /** The board's own workplace label, e.g. "hybrid" or "OnSite". */
  workplaceLabel?: unknown;
  /** Used only when the board gives no workplace label. */
  remoteFlag?: boolean;
  /** The board's own experience label, e.g. Personio "entry-level" or Recruitee "student_college". */
  seniorityLabel?: unknown;
};

function finish(j: RawJob): NormalizedJob {
  const { employmentLabel, workplaceLabel, remoteFlag, seniorityLabel, ...rest } = j;
  const description = rest.description.slice(0, MAX_DESCRIPTION);
  const fromTitle = inferEmployment(rest.title, description);
  // Boards often label internships "Full-time", so a clear internship or working-student title wins.
  const employment_type =
    fromTitle === 'internship' || fromTitle === 'working_student' ? fromTitle : (employmentFromLabel(employmentLabel) ?? fromTitle);
  const workplace =
    workplaceFromLabel(workplaceLabel) ?? (remoteFlag ? 'remote' : inferWorkplace(rest.title, rest.location, description));
  // A seniority word in the title is most specific; otherwise use the board's experience label.
  const titleSeniority = inferSeniority(rest.title, employment_type);
  const seniority = titleSeniority !== 'mid' ? titleSeniority : (seniorityFromLabel(seniorityLabel) ?? 'mid');
  const content_hash = createHash('sha256')
    .update(JSON.stringify([rest.title, rest.location, rest.apply_url, description]))
    .digest('hex');
  return {
    ...rest,
    description,
    remote: workplace === 'remote',
    employment_type,
    workplace,
    seniority,
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

export async function fetchBoard(kind: BoardKind, token: string, opts: FetchOptions = {}): Promise<NormalizedJob[]> {
  if (!TOKEN.test(token)) throw new Error('Invalid board token.');
  const t = encodeURIComponent(token);
  if (kind === 'arbeitnow') return fetchArbeitnow();

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

  if (kind === 'ashby') {
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

  if (kind === 'personio') return fetchPersonio(token);
  if (kind === 'recruitee') return fetchRecruitee(token);
  if (kind === 'workable') return fetchWorkable(token);
  return fetchSmartRecruiters(token, opts);
}

const arbeitnowItem = z.object({
  slug: z.string().min(1).max(500), title: z.string().trim().min(1),
  company_name: z.string().trim().min(1), location: z.string().default(''),
  url: z.url({ protocol: /^https$/ }), description: z.string().default(''),
  remote: z.boolean().optional(), created_at: z.number().int().nonnegative().optional(),
  job_types: z.array(z.string()).optional(),
});

async function fetchArbeitnow(): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const endpoint = 'https://www.arbeitnow.com/api/job-board-api';
  for (let page = 1; page <= 3; page++) {
    const payload = z.object({
      data: z.array(z.unknown()), links: z.object({ next: z.string().nullable() }),
    }).parse(await getJson(endpoint + '?page=' + page));
    for (const raw of payload.data) {
      const job = arbeitnowItem.safeParse(raw);
      if (!job.success) continue;
      const item = job.data;
      jobs.push(finish({
        external_id: item.slug, company: item.company_name, title: item.title, location: item.location,
        remoteFlag: item.remote, url: item.url, apply_url: item.url, description: htmlToText(decodeEntities(item.description)),
        posted_at: item.created_at === undefined ? null : iso(item.created_at * 1000),
        employmentLabel: item.job_types?.[0],
      }));
    }
    if (!payload.links.next) break;
  }
  return jobs;
}

// ---------- Personio: public XML feed (https://<company>.jobs.personio.de/xml) ----------

function xmlText(s: string): string {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decodeEntities(s);
}
const xmlAll = (block: string, tag: string) =>
  [...block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => xmlText(m[1]).trim());
const xmlOne = (block: string, tag: string) => xmlAll(block, tag)[0] ?? '';

export function parsePersonioXml(xml: string, token: string): NormalizedJob[] {
  const company = companyFromToken(token);
  return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(([, p]) => {
        const id = xmlOne(p, 'id');
        const offices = [xmlOne(p, 'office'), ...xmlAll(xmlOne(p, 'additionalOffices') || '', 'office')].filter(Boolean);
        const sections = [...p.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)].map(
          ([, d]) => `${xmlOne(d, 'name')}\n${htmlToText(xmlOne(d, 'value'))}`,
        );
        const keywords = xmlOne(p, 'keywords');
        const employment = xmlOne(p, 'employmentType');
        const schedule = xmlOne(p, 'schedule');
        const url = `https://${token}.jobs.personio.de/job/${id}?language=en`;
        return finish({
          external_id: id,
          company,
          title: xmlOne(p, 'name'),
          location: [...new Set(offices)].join(', '),
          // Personio separates contract type ("permanent", "intern") from hours ("part-time").
          employmentLabel: employment === 'permanent' && schedule === 'part-time' ? 'part-time' : employment,
          seniorityLabel: xmlOne(p, 'seniority'),
          url,
          apply_url: url,
          description: [...sections, keywords && `Keywords: ${keywords}`].filter(Boolean).join('\n\n'),
          posted_at: iso(xmlOne(p, 'createdAt')),
        });
      });
}

async function fetchPersonio(token: string): Promise<NormalizedJob[]> {
  const res = await fetch(`https://${encodeURIComponent(token)}.jobs.personio.de/xml?language=en`, {
    headers: { accept: 'application/xml', 'user-agent': 'job-agent/0.1' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) throw new Error('Board not found. Check the company name in the Personio address.');
  if (!res.ok) throw new Error(`Job board responded with HTTP ${res.status}.`);
  const xml = await res.text();
  if (!xml.includes('<workzag-jobs')) throw new Error('This Personio account has no public job feed.');
  return parsePersonioXml(xml, token);
}

// ---------- Recruitee: public offers API (https://<company>.recruitee.com/api/offers/) ----------

async function fetchRecruitee(token: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://${encodeURIComponent(token)}.recruitee.com/api/offers/`);
  return (data.offers ?? [])
    .filter((o: any) => !o.status || o.status === 'published')
    .map((o: any) =>
      finish({
        external_id: String(o.id),
        company: o.company_name || companyFromToken(token),
        title: String(o.title ?? '').trim(),
        location: [o.city, o.country].filter(Boolean).join(', ') || o.location || '',
        employmentLabel: o.employment_type_code,
        workplaceLabel: o.remote ? 'remote' : o.hybrid ? 'hybrid' : o.on_site ? 'onsite' : undefined,
        seniorityLabel: o.experience_code,
        url: o.careers_url,
        apply_url: o.careers_apply_url ?? o.careers_url,
        description: [htmlToText(String(o.description ?? '')), htmlToText(String(o.requirements ?? ''))].filter(Boolean).join('\n\n'),
        // Recruitee dates look like "2026-11-10 07:45:05 UTC".
        posted_at: iso(String(o.published_at ?? o.created_at ?? '').replace(' UTC', 'Z').replace(' ', 'T')),
      }),
    );
}

// ---------- Workable: public widget API (https://apply.workable.com/<company>) ----------

async function fetchWorkable(token: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`);
  return (data.jobs ?? []).map((j: any) =>
    finish({
      external_id: String(j.shortcode),
      company: data.name || companyFromToken(token),
      title: String(j.title ?? '').trim(),
      location: [j.city, j.state, j.country].filter(Boolean).join(', '),
      employmentLabel: j.employment_type,
      remoteFlag: j.telecommuting === true,
      seniorityLabel: j.experience,
      url: j.url ?? j.shortlink,
      apply_url: j.application_url ?? j.url,
      description: htmlToText(String(j.description ?? '')),
      posted_at: iso(j.published_on ?? j.created_at),
    }),
  );
}

// ---------- SmartRecruiters: public Posting API (https://jobs.smartrecruiters.com/<company>) ----------

const SR_MAX_POSTINGS = 1000;
const SR_DETAILS_PER_SYNC = 150;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * The list endpoint has no descriptions, and each description costs one request. Descriptions are
 * fetched only for new or re-released postings, up to SR_DETAILS_PER_SYNC per sync; the rest are
 * matched on title for now and filled in on later syncs.
 */
async function fetchSmartRecruiters(token: string, opts: FetchOptions): Promise<NormalizedJob[]> {
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings`;
  const postings: any[] = [];
  for (let offset = 0; offset < SR_MAX_POSTINGS; offset += 100) {
    const page = await getJson(`${base}?limit=100&offset=${offset}`);
    postings.push(...(page.content ?? []));
    if (postings.length >= (page.totalFound ?? 0) || !(page.content ?? []).length) break;
  }
  const known = opts.known ?? new Map<string, string | null>();
  const released = (p: any) => iso(p.releasedDate);
  const needs = postings.filter((p) => !known.has(String(p.id)) || known.get(String(p.id)) !== released(p));
  const toFetch = new Set(needs.slice(0, SR_DETAILS_PER_SYNC).map((p) => String(p.id)));
  const details = new Map<string, any>();
  await mapLimit([...toFetch], 5, async (id) => {
    try {
      details.set(id, await getJson(`${base}/${encodeURIComponent(id)}`));
    } catch {
      // Leave this posting without a description; a later sync retries it.
    }
  });

  return postings.map((p) => {
    const id = String(p.id);
    const d = details.get(id);
    const sections = d?.jobAd?.sections ?? {};
    const description = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
      .map((k) => htmlToText(String(sections[k]?.text ?? '')))
      .filter(Boolean)
      .join('\n\n');
    const url = d?.postingUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${id}`;
    const job = finish({
      external_id: id,
      company: p.company?.name || companyFromToken(token),
      title: String(p.name ?? '').trim(),
      location: p.location?.fullLocation ?? [p.location?.city, p.location?.country?.toUpperCase()].filter(Boolean).join(', '),
      employmentLabel: p.typeOfEmployment?.label,
      workplaceLabel: p.location?.remote ? 'remote' : p.location?.hybrid ? 'hybrid' : 'onsite',
      seniorityLabel: p.experienceLevel?.label,
      url,
      apply_url: d?.applyUrl ?? url,
      description,
      posted_at: released(p),
    });
    // Unchanged postings already stored with a description keep it instead of being blanked.
    return d || !known.has(id) || known.get(id) !== released(p) ? job : { ...job, keep_description: true };
  });
}

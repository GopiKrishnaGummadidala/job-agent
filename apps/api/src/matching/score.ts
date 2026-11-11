/** Stage 1 matching: deterministic, explainable, and free. No model is called here. */

export interface ScoreJob {
  company: string;
  title: string;
  location: string;
  remote: boolean;
  description: string;
}

export interface ScoreProfile {
  skills: string[];
}

export interface ScorePrefs {
  titles: string[];
  keywords: string[];
  locations: string[];
  remote_ok: boolean;
  excluded_companies: string[];
  excluded_keywords: string[];
}

export interface Reason {
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface ScoreResult {
  score: number;
  filtered: boolean;
  reasons: Reason[];
  unknowns: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-term match that also works for terms such as "C#", "C++" and ".NET". */
export function hasTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

const clean = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter(Boolean))];

export function scoreJob(job: ScoreJob, profile: ScoreProfile, prefs: ScorePrefs): ScoreResult {
  const reasons: Reason[] = [];
  const unknowns: string[] = [];
  const reject = (detail: string): ScoreResult => ({
    score: 0,
    filtered: true,
    reasons: [{ label: 'Filtered out', points: 0, max: 0, detail }],
    unknowns,
  });

  const blockedCompany = clean(prefs.excluded_companies).find((c) => hasTerm(job.company, c));
  if (blockedCompany) return reject(`Company "${blockedCompany}" is on your exclusion list.`);
  const blockedWord = clean(prefs.excluded_keywords).find((k) => hasTerm(job.title, k));
  if (blockedWord) return reject(`Title contains excluded keyword "${blockedWord}".`);

  // Location (20)
  const locations = clean(prefs.locations);
  const place = locations.find((l) => job.location.toLowerCase().includes(l.toLowerCase()));
  if (place) {
    reasons.push({ label: 'Location', points: 20, max: 20, detail: `Located in ${place}.` });
  } else if (job.remote && prefs.remote_ok) {
    reasons.push({ label: 'Location', points: 20, max: 20, detail: 'Remote role, and you accept remote work.' });
  } else if (!locations.length) {
    reasons.push({ label: 'Location', points: 10, max: 20, detail: 'No preferred locations set.' });
    unknowns.push('Add preferred locations to rank by location.');
  } else if (!job.location.trim()) {
    reasons.push({ label: 'Location', points: 10, max: 20, detail: 'The posting does not state a location.' });
    unknowns.push('Location is not stated in the posting.');
  } else {
    return reject(`Location "${job.location}" is outside your preferred locations.`);
  }

  // Title (40)
  const titles = clean(prefs.titles);
  if (!titles.length) {
    reasons.push({ label: 'Role', points: 20, max: 40, detail: 'No target roles set.' });
    unknowns.push('Add target roles to rank by job title.');
  } else {
    let best = { ratio: 0, title: '' };
    for (const t of titles) {
      const words = t.split(/\s+/).filter(Boolean);
      const ratio = hasTerm(job.title, t) ? 1 : words.filter((w) => hasTerm(job.title, w)).length / words.length;
      if (ratio > best.ratio) best = { ratio, title: t };
    }
    const points = best.ratio >= 0.5 ? Math.round(40 * best.ratio) : 0;
    reasons.push({
      label: 'Role',
      points,
      max: 40,
      detail: points ? `Title matches target role "${best.title}".` : 'Title does not match any target role.',
    });
  }

  // Skills (40)
  const terms = clean([...profile.skills, ...prefs.keywords]);
  if (!terms.length) {
    reasons.push({ label: 'Skills', points: 0, max: 40, detail: 'No skills or keywords in your profile yet.' });
    unknowns.push('Add skills to your profile to rank by skills.');
  } else {
    const haystack = `${job.title}\n${job.description}`;
    const matched = terms.filter((t) => hasTerm(haystack, t));
    const points = Math.min(40, Math.round((40 * matched.length) / Math.min(terms.length, 6)));
    reasons.push({
      label: 'Skills',
      points,
      max: 40,
      detail: matched.length
        ? `Mentions ${matched.length} of your skills: ${matched.slice(0, 12).join(', ')}.`
        : 'None of your skills are mentioned in the posting.',
    });
  }

  return { score: reasons.reduce((sum, r) => sum + r.points, 0), filtered: false, reasons, unknowns };
}

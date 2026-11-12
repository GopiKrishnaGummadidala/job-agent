/**
 * Employment type, workplace and seniority for each job. Boards that publish these fields
 * (Lever, Ashby) are used as-is; otherwise the values are inferred from the title, location
 * and the start of the description.
 */

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'temporary', 'internship', 'working_student'] as const;
export const WORKPLACES = ['remote', 'hybrid', 'onsite'] as const;
export const SENIORITIES = ['intern', 'junior', 'mid', 'senior', 'staff', 'lead'] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type Workplace = (typeof WORKPLACES)[number];
export type Seniority = (typeof SENIORITIES)[number];

/** Maps a board's own label (e.g. Lever "Full-time", Ashby "PartTime") to our type. */
export function employmentFromLabel(label: unknown): EmploymentType | null {
  const s = String(label ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return null;
  if (s.includes('student') || s.includes('werkstud')) return 'working_student';
  if (s.includes('intern') || s.includes('scholarship') || s.includes('praktik') || s.includes('apprentice')) return 'internship';
  if (s.includes('parttime') || s.includes('teilzeit')) return 'part_time';
  if (s.includes('contract') || s.includes('freelance')) return 'contract';
  if (s.includes('temp') || s.includes('shortterm') || s.includes('fixedterm') || s.includes('befristet')) return 'temporary';
  if (s.includes('fulltime') || s.includes('permanent') || s.includes('vollzeit') || s.includes('regular')) return 'full_time';
  return null;
}

export function inferEmployment(title: string, description: string): EmploymentType {
  const t = title.toLowerCase();
  const head = description.slice(0, 2000).toLowerCase();
  if (/\b(working student|werkstudent(in)?)\b/.test(t) || /\bwerkstudent(in)?\b/.test(head)) return 'working_student';
  if (/\b(intern|internship|praktikum|praktikant(in)?|apprentice(ship)?|ausbildung)\b/.test(t)) return 'internship';
  if (/\b(part[- ]time|teilzeit)\b/.test(t) || /\b(this is a|is a) part[- ]time\b/.test(head)) return 'part_time';
  // "Contract" and "temporary" are only trusted in the title: descriptions use them in other senses.
  if (/\b(contract(or)?|freelance(r)?|freiberuflich)\b/.test(t)) return 'contract';
  if (/\b(temporary|fixed[- ]term|befristet|maternity cover|parental leave cover)\b/.test(t)) return 'temporary';
  return 'full_time';
}

export function workplaceFromLabel(label: unknown): Workplace | null {
  const s = String(label ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'remote') return 'remote';
  if (s === 'hybrid') return 'hybrid';
  if (s === 'onsite' || s === 'inoffice' || s === 'office') return 'onsite';
  return null;
}

export function inferWorkplace(title: string, location: string, description: string): Workplace {
  const where = `${title} ${location}`;
  if (/\bhybrid\b/i.test(where)) return 'hybrid';
  if (/\b(remote|home[- ]?office|work from home|wfh)\b/i.test(where)) return 'remote';
  const head = description.slice(0, 3000);
  if (/\bhybrid (work|working|role|model|setup|position)\b/i.test(head)) return 'hybrid';
  if (/\b(fully|100%) remote\b/i.test(head)) return 'remote';
  return 'onsite';
}

/** Maps a board's experience label to a seniority; generic labels ("experienced") return null. */
export function seniorityFromLabel(label: unknown): Seniority | null {
  const s = String(label ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return null;
  if (s.includes('student') || s.includes('intern')) return 'intern';
  if (s.includes('entry') || s.includes('junior') || s.includes('graduate')) return 'junior';
  if (s.includes('executive') || s.includes('director') || s.includes('manager')) return 'lead';
  if (s === 'midlevel' || s === 'midseniorlevel' || s === 'associate') return 'mid';
  return null;
}

export function inferSeniority(title: string, employment: EmploymentType): Seniority {
  if (employment === 'internship' || employment === 'working_student') return 'intern';
  const t = title.toLowerCase();
  if (/\b(staff|principal|distinguished|fellow)\b/.test(t)) return 'staff';
  if (/\b(head of|director|vp|vice president|chief|manager|lead)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|entry[- ]level|graduate|associate|trainee)\b/.test(t)) return 'junior';
  return 'mid';
}

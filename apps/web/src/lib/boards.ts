/** Job board systems the API can read, with their display names and address formats. */
export const BOARD_LABEL: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  personio: 'Personio',
  recruitee: 'Recruitee',
  workable: 'Workable',
  smartrecruiters: 'SmartRecruiters',
};

export const BOARD_FORMATS: [string, string][] = [
  ['Greenhouse', 'job-boards.greenhouse.io/<company>'],
  ['Lever', 'jobs.lever.co/<company>'],
  ['Ashby', 'jobs.ashbyhq.com/<company>'],
  ['Personio', '<company>.jobs.personio.de'],
  ['Recruitee', '<company>.recruitee.com'],
  ['Workable', 'apply.workable.com/<company>'],
  ['SmartRecruiters', 'jobs.smartrecruiters.com/<company>'],
];

import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';
import { berlinMeetingTime, CalendarMeetings, calendarKey, type CalendarMeeting } from './CalendarMeetings';

const stages = { unknown: 'Round unknown', screen: 'Screening', first: 'First round', second: 'Second round', final: 'Final round' };
const outcomes = { review: 'Needs review', positive: 'Positive response', scheduled: 'Interview scheduled', rejected: 'Rejected', offer: 'Offer', unrelated: 'Unrelated' };
type Interview = {
  message_id: string; subject: string; sender: string; received_at: string;
  company: string; job_title: string; stage: keyof typeof stages; outcome: keyof typeof outcomes;
  calendar?: CalendarMeeting;
};
const queryKey = ['private-interviews'];
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function InterviewsPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<'upcoming' | 'history'>('upcoming');
  const [form, setForm] = useState<Interview | null>(null);
  const [filter, setFilter] = useState('advancing');
  const [cursor, setCursor] = useState<string>();
  const [added, setAdded] = useState<number>();
  const interviews = useQuery({
    queryKey,
    queryFn: () => api<Interview[]>('/me/gmail/interviews'),
  });
  const calendar = useQuery({
    queryKey: calendarKey,
    queryFn: () => api<{ connected: boolean; meetings: CalendarMeeting[] }>('/me/gmail/calendar/interviews'),
  });
  const scan = useMutation({
    mutationFn: async () => {
      let next = cursor;
      do {
        const page = await api<{ added: number; next: string | null }>('/me/gmail/interviews/import', {
          method: 'POST', json: { cursor: next },
        });
        setAdded((count) => (count ?? 0) + page.added);
        next = page.next ?? undefined;
        setCursor(next);
      } while (next);
    },
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });
  const save = useMutation({
    mutationFn: ({ message_id, company, job_title, stage, outcome }: Interview) =>
      api('/me/gmail/interviews/' + encodeURIComponent(message_id), {
        method: 'PATCH', json: { company, job_title, stage, outcome },
      }),
    onSuccess: async () => {
      setForm(null);
      await qc.invalidateQueries({ queryKey });
    },
  });
  const matchesFilter = ({ outcome }: Interview) => {
    if (filter === 'advancing') return outcome === 'positive' || outcome === 'scheduled' || outcome === 'offer';
    return filter === 'all' ? outcome !== 'unrelated' : outcome === filter;
  };
  const histories = new Map<string, Interview[]>();
  const calendarRows: Interview[] = (calendar.data?.meetings ?? []).map((item) => ({
    message_id: 'calendar:' + item.event_id, subject: item.title, sender: 'Google Calendar',
    received_at: item.starts_at, company: item.company, job_title: item.job_title,
    stage: 'unknown', outcome: 'scheduled', calendar: item,
  }));
  const rows = [...(interviews.data ?? []), ...calendarRows].sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
  for (const row of rows) {
    if (row.outcome === 'unrelated' && filter !== 'unrelated') continue;
    const company = normalize(row.company);
    const role = normalize(row.job_title);
    const key = company && role ? JSON.stringify([company, role]) : row.message_id;
    const history = histories.get(key) ?? [];
    history.push(row);
    histories.set(key, history);
  }
  const companies = new Map<string, { name: string; histories: { key: string; replies: Interview[] }[] }>();
  for (const [key, replies] of histories) {
    if (!replies.some(matchesFilter)) continue;
    const name = replies[0].company.trim() || 'Company unknown';
    const company = normalize(name);
    const group = companies.get(company) ?? { name, histories: [] };
    group.histories.push({ key, replies });
    companies.set(company, group);
  }

  return (
    <>
      <PageHeader title="Interviews" subtitle="Private to your account. Shared workspace members have no access."
        actions={view === 'history' && <Button variant="contained" disabled={scan.isPending} onClick={() => {
          if (!cursor) setAdded(0);
          scan.mutate();
        }}>{scan.isPending ? 'Scanning Gmail…' : cursor ? 'Resume scan' : 'Scan Gmail'}</Button>} />
      <Tabs value={view} onChange={(_, value) => setView(value)} aria-label="Interview views" sx={{ mb: 2 }}>
        <Tab value="upcoming" label="Upcoming" />
        <Tab value="history" label="History" />
      </Tabs>
      <ErrorAlert error={calendar.error} />
      {calendar.isPending && <LoadingBlock />}
      {view === 'upcoming' && calendar.data && <CalendarMeetings connected={calendar.data.connected} confirmed={calendar.data.meetings} />}
      {view === 'history' && <Stack spacing={2}>
        <Alert severity="info">
          Search read and unread mail for likely recruiting responses in English and German. Review the matches and fill in the job title and interview round where needed. Gmail read status stays the same.
        </Alert>
        <ErrorAlert error={interviews.error ?? scan.error} />
        {added !== undefined && <Typography role="status">{added} new messages imported{scan.isPending ? ' so far' : ''}.</Typography>}
        <TextField select size="small" label="Outcome" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ width: 220 }}>
          <MenuItem value="advancing">Invitations and offers</MenuItem>
          <MenuItem value="all">All relevant responses</MenuItem>
          {Object.entries(outcomes).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
        </TextField>
        {interviews.isPending && <LoadingBlock />}
        {interviews.isSuccess && !companies.size && <Typography color="text.secondary">No responses match this view.</Typography>}
        {[...companies.values()].map(({ name, histories: companyHistories }) => (
          <Box component="section" key={name}>
            <Typography component="h2" variant="h6" sx={{ mb: 1 }}>{name}</Typography>
            <Stack spacing={1}>
              {companyHistories.map(({ key, replies }) => {
                const newest = replies[0];
                const latestOutcome = replies.find((row) => !row.calendar && row.outcome !== 'review') ?? newest;
                const latestRound = replies.find((row) => row.stage !== 'unknown')?.stage ?? 'unknown';
                return (
                  <Accordion key={key} variant="outlined" disableGutters>
                    <AccordionSummary expandIcon={<ChevronDown size={18} aria-hidden />}>
                      <Stack spacing={0.75} sx={{ width: '100%', overflowWrap: 'anywhere', pr: 1 }}>
                        <Typography variant="subtitle1">{newest.job_title || newest.subject || 'Recruiting response'}</Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
                          <Chip size="small" color={latestOutcome.outcome === 'rejected' ? 'error' : 'default'} label={outcomes[latestOutcome.outcome]} />
                          {latestRound !== 'unknown' && <Chip size="small" variant="outlined" label={stages[latestRound]} />}
                          <Typography variant="caption" color="text.secondary">
                            {replies.length} {replies.length === 1 ? 'message' : 'messages'} · {fmtDateTime(newest.received_at)}
                          </Typography>
                        </Box>
                      </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Stack spacing={1.5} divider={<Box sx={{ borderBottom: 1, borderColor: 'divider' }} />}>
                        {replies.map((row) => (
                          <Box key={row.message_id} sx={{ overflowWrap: 'anywhere' }}>
                            <Typography variant="body2">{row.subject || 'Recruiting response'}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {row.sender} · {row.calendar ? berlinMeetingTime.format(new Date(row.received_at)) + ' Berlin time' : fmtDateTime(row.received_at)}
                            </Typography>
                            <Box sx={{ mt: 0.5, display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
                              <Chip size="small" label={outcomes[row.outcome]} />
                              <Chip size="small" variant="outlined" label={stages[row.stage]} />
                              {row.calendar ? (
                                row.calendar.calendar_url && <Button size="small" href={row.calendar.calendar_url} target="_blank" rel="noopener noreferrer">Open Calendar</Button>
                              ) : (
                                <>
                                  <Button size="small" component="a" href={'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(row.message_id)}
                                    target="_blank" rel="noopener noreferrer">Open email</Button>
                                  <Button size="small" onClick={() => { save.reset(); setForm(row); }}>Edit</Button>
                                </>
                              )}
                            </Box>
                          </Box>
                        ))}
                      </Stack>
                    </AccordionDetails>
                  </Accordion>
                );
              })}
            </Stack>
          </Box>
        ))}
      </Stack>}
      {form && (
        <Dialog open fullWidth maxWidth="sm" onClose={() => { if (!save.isPending) setForm(null); }}>
          <Box component="form" onSubmit={(event) => { event.preventDefault(); save.mutate(form); }}>
            <DialogTitle>Edit interview response</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ pt: 1 }}>
                <TextField label="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
                <TextField label="Job title" value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} />
                <TextField select label="Round reached" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as Interview['stage'] })}>
                  {Object.entries(stages).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
                </TextField>
                <TextField select label="Outcome" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value as Interview['outcome'] })}>
                  {Object.entries(outcomes).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
                </TextField>
                <ErrorAlert error={save.error} />
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button disabled={save.isPending} onClick={() => setForm(null)}>Cancel</Button>
              <Button disabled={save.isPending} variant="contained" type="submit">Save</Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
    </>
  );
}

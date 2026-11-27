import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorAlert, LoadingBlock } from '../../components/ui';
import { api } from '../../lib/api';

type Event = { event_id: string; title: string; starts_at: string; meeting_url: string | null; calendar_url: string | null };
export type CalendarMeeting = Event & { company: string; job_title: string };
export const calendarKey = ['private-calendar-interviews'];
export const berlinMeetingTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin',
});

export function CalendarMeetings({ connected, confirmed }: { connected: boolean; confirmed: CalendarMeeting[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<CalendarMeeting | null>(null);
  const [showAll, setShowAll] = useState(false);
  const events = useQuery({
    queryKey: ['private-calendar-upcoming'], enabled: connected,
    queryFn: () => api<Event[]>('/me/gmail/calendar/upcoming'),
  });
  const connect = useMutation({
    mutationFn: () => api<{ url: string }>('/me/gmail/connect?purpose=calendar', { method: 'POST' }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const save = useMutation({
    mutationFn: ({ event_id, company, job_title }: CalendarMeeting) =>
      api('/me/gmail/calendar/interviews', { method: 'POST', json: { event_id, company, job_title } }),
    onSuccess: async () => { setForm(null); await qc.invalidateQueries({ queryKey: calendarKey }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('/me/gmail/calendar/interviews/' + encodeURIComponent(id), { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: calendarKey }),
  });
  const rows = (events.data ?? []).filter((event) => Date.parse(event.starts_at) >= Date.now()
    && (showAll || /\b(?:interview|recruiting|recruitment|screening|vorstellungsgespräch|kennenlerngespräch|bewerbungsgespräch)\b/i.test(event.title)
      || confirmed.some((item) => item.event_id === event.event_id)));
  return (
    <Stack spacing={2}>
      <Alert severity="info">
        Review likely interviews on your primary calendar for the next 90 days. Only meetings you confirm are saved in Interviews.
      </Alert>
      <ErrorAlert error={events.error ?? connect.error ?? remove.error} />
      {new URLSearchParams(location.search).get('calendar') === 'failed' && (
        <Alert severity="warning">Google Calendar could not connect. Try connecting again.</Alert>
      )}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button variant={connected ? 'outlined' : 'contained'} disabled={connect.isPending} onClick={() => connect.mutate()}>
          {connected ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
        </Button>
        {connected && <Button disabled={events.isFetching} onClick={() => void events.refetch()}>Refresh meetings</Button>}
        {connected && <Button onClick={() => setShowAll(!showAll)}>{showAll ? 'Show likely interviews' : 'Show all meetings'}</Button>}
      </Box>
      {connected && events.isPending && <LoadingBlock />}
      {events.isSuccess && !rows.length && <Typography color="text.secondary">No upcoming meetings found.</Typography>}
      {rows.map((event) => {
        const saved = confirmed.find((item) => item.event_id === event.event_id);
        const url = event.meeting_url ?? event.calendar_url;
        return (
          <Paper key={event.event_id} variant="outlined" sx={{ p: 2, overflowWrap: 'anywhere' }}>
            <Typography component="h2" variant="subtitle1">{event.title}</Typography>
            <Typography variant="body2" color="text.secondary">{berlinMeetingTime.format(new Date(event.starts_at))} · Berlin time</Typography>
            {saved && <Typography variant="body2">{saved.company} · {saved.job_title}</Typography>}
            <Button size="small" onClick={() => { save.reset(); setForm({ company: '', job_title: '', ...saved, ...event }); }}>
              {saved ? 'Edit interview link' : 'Confirm as interview'}
            </Button>
            {saved && <Button size="small" disabled={remove.isPending} onClick={() => remove.mutate(event.event_id)}>Remove from Interviews</Button>}
            {saved && url && <Button size="small" href={url} target="_blank" rel="noopener noreferrer">{event.meeting_url ? 'Join meeting' : 'Open Calendar'}</Button>}
          </Paper>
        );
      })}
      {form && (
        <Dialog open fullWidth maxWidth="sm" onClose={() => { if (!save.isPending) setForm(null); }}>
          <Box component="form" onSubmit={(event) => { event.preventDefault(); save.mutate(form); }}>
            <DialogTitle>Link meeting to an interview</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ pt: 1 }}>
                <TextField autoFocus required label="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
                <TextField required label="Job title" value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} />
                <ErrorAlert error={save.error} />
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button disabled={save.isPending} onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit" variant="contained" disabled={save.isPending}>Save interview</Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
    </Stack>
  );
}

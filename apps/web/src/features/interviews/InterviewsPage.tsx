import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';

const stages = { unknown: 'Round unknown', screen: 'Screening', first: 'First round', second: 'Second round', final: 'Final round' };
const outcomes = { review: 'Needs review', positive: 'Positive response', scheduled: 'Interview scheduled', rejected: 'Rejected', offer: 'Offer', unrelated: 'Unrelated' };
type Interview = {
  message_id: string; subject: string; sender: string; received_at: string;
  company: string; job_title: string; stage: keyof typeof stages; outcome: keyof typeof outcomes;
};
const queryKey = ['private-interviews'];

export function InterviewsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<Interview | null>(null);
  const [filter, setFilter] = useState('all');
  const [cursor, setCursor] = useState<string>();
  const [added, setAdded] = useState<number>();
  const interviews = useQuery({
    queryKey,
    queryFn: () => api<Interview[]>('/me/gmail/interviews'),
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
  const rows = (interviews.data ?? []).filter(({ outcome }) => filter === 'all' ? outcome !== 'unrelated' : outcome === filter);

  return (
    <>
      <PageHeader title="Interviews" subtitle="Private to your account. Shared workspace members have no access."
        actions={<Button variant="contained" disabled={scan.isPending} onClick={() => {
          if (!cursor) setAdded(0);
          scan.mutate();
        }}>{scan.isPending ? 'Scanning Gmail…' : cursor ? 'Resume scan' : 'Scan Gmail'}</Button>} />
      <Stack spacing={2}>
        <Alert severity="info">
          Search read and unread mail for likely recruiting responses in English and German. Review the matches and fill in the job title and interview round where needed. Gmail read status stays the same.
        </Alert>
        <ErrorAlert error={interviews.error ?? scan.error} />
        {added !== undefined && <Typography role="status">{added} new messages imported{scan.isPending ? ' so far' : ''}.</Typography>}
        <TextField select size="small" label="Outcome" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ width: 220 }}>
          <MenuItem value="all">All relevant responses</MenuItem>
          {Object.entries(outcomes).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
        </TextField>
        {interviews.isPending && <LoadingBlock />}
        {interviews.isSuccess && !rows.length && <Typography color="text.secondary">No responses match this view.</Typography>}
        {rows.map((row) => (
          <Paper key={row.message_id} variant="outlined" sx={{ p: 2, overflowWrap: 'anywhere' }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ justifyContent: 'space-between' }}>
              <Box>
                <Typography component="h2" variant="subtitle1">{row.job_title || row.subject || 'Recruiting response'}</Typography>
                {row.company && <Typography variant="body2">{row.company}</Typography>}
                {row.job_title && <Typography variant="body2" color="text.secondary">{row.subject}</Typography>}
                <Typography variant="caption" color="text.secondary">{row.sender} · {fmtDateTime(row.received_at)}</Typography>
              </Box>
              <Box>
                <Button component="a" href={'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(row.message_id)}
                  target="_blank" rel="noopener noreferrer">Open email</Button>
                <Button onClick={() => { save.reset(); setForm(row); }}>Edit</Button>
              </Box>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Chip size="small" label={outcomes[row.outcome]} />
              <Chip size="small" variant="outlined" label={stages[row.stage]} />
            </Stack>
          </Paper>
        ))}
      </Stack>
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

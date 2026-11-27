import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';
import { BOARD_FORMATS, BOARD_LABEL } from '../../lib/boards';

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Sources & Settings" subtitle="Where jobs come from, which AI to use, and how much it may cost." />
      <Box className="grid gap-4 lg:grid-cols-2">
        <SourcesCard />
        <AiCard />
        <GmailCard />
        <DiscoveryRunsCard />
      </Box>
    </>
  );
}

function DiscoveryRunsCard() {
  const qc = useQueryClient();
  const requests = useQuery({
    queryKey: ['sources', 'requests'],
    queryFn: () => api<{ id: string; token: string; status: string; requested_at: string; attempts: number; error_details: string | null; can_cancel: boolean }[]>('/me/sources/requests'),
    refetchInterval: (query) => query.state.data?.some((item) => item.status === 'queued' || item.status === 'running') ? 3000 : false,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api('/me/sources/requests/' + id + '/cancel', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sources', 'requests'] }),
  });
  const latestFinished = requests.data?.find((item) => item.status === 'completed' || item.status === 'failed')?.id;
  useEffect(() => {
    if (latestFinished) {
      void qc.invalidateQueries({ queryKey: ['sources'], exact: true });
      void qc.invalidateQueries({ queryKey: ['sources', 'runs'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    }
  }, [latestFinished, qc]);
  const runs = useQuery({
    queryKey: ['sources', 'runs'],
    queryFn: () => api<{
      id: string; kind: string; token: string; status: string; started_at: string;
      jobs_discovered: number; jobs_inserted: number; jobs_updated: number;
      duplicates_prevented: number; failed_records: number; error_details?: string;
    }[]>('/me/sources/runs'),
  });
  return (
    <Paper className="p-4">
      <Typography variant="h6" component="h2">Board refresh history</Typography>
      <ErrorAlert error={runs.error ?? requests.error ?? cancel.error} />
      {!!requests.data?.length && (
        <List dense sx={{ maxHeight: 220, overflow: 'auto' }} aria-label="Manual refresh requests">
          {requests.data.map((item) => (
            <ListItem key={item.id} divider secondaryAction={item.can_cancel && (
              <Button size="small" disabled={cancel.isPending} onClick={() => cancel.mutate(item.id)}>Cancel</Button>
            )}>
              <ListItemText primary={`${item.token} · ${item.status}`}
                secondary={`${fmtDateTime(item.requested_at)}${item.error_details ? ' · ' + item.error_details : ''}`} />
            </ListItem>
          ))}
        </List>
      )}
      {runs.isPending && <LoadingBlock rows={2} />}
      {runs.data?.length === 0 && <Typography color="text.secondary">No board refreshes recorded yet.</Typography>}
      {!!runs.data?.length && (
        <List dense sx={{ maxHeight: 360, overflow: 'auto' }}>
          {runs.data.map((run) => (
            <ListItem key={run.id} divider>
              <ListItemText
                primary={`${BOARD_LABEL[run.kind] ?? run.kind} · ${run.token} · ${run.status}`}
                secondary={run.error_details ?? `${fmtDateTime(run.started_at)} · ${run.jobs_discovered} found · ${run.jobs_inserted} new · ${run.jobs_updated} changed · ${run.duplicates_prevented} duplicates · ${run.failed_records} invalid`}
              />
            </ListItem>
          ))}
        </List>
      )}
    </Paper>
  );
}

function GmailCard() {
  const qc = useQueryClient();
  const result = new URLSearchParams(window.location.search).get('gmail');
  const gmail = useQuery({
    queryKey: ['gmail'],
    queryFn: () => api<{ configured: boolean; connection: { email: string } | null }>('/me/gmail'),
  });
  const connect = useMutation({
    mutationFn: () => api<{ url: string }>('/me/gmail/connect', { method: 'POST' }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const disconnect = useMutation({
    mutationFn: () => api('/me/gmail', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail'] }),
  });
  return (
    <Paper className="p-4">
      <Typography variant="h6" component="h2">Gmail</Typography>
      <Typography variant="body2" color="text.secondary" className="mb-3">
        Connect your mailbox for job alerts. Google asks for permission to read messages and mark them as read.
      </Typography>
      <ErrorAlert error={gmail.error ?? connect.error ?? disconnect.error} />
      {result === 'failed' && <Alert severity="warning">Gmail could not be connected. Try connecting again.</Alert>}
      {gmail.isLoading && <LoadingBlock rows={1} />}
      {gmail.data?.connection ? (
        <Box className="flex flex-wrap items-center gap-2">
          <Typography variant="body2">Connected as {gmail.data.connection.email}</Typography>
          <Button onClick={() => disconnect.mutate()} disabled={disconnect.isPending || !gmail.data.configured}>
            Disconnect Gmail
          </Button>
        </Box>
      ) : gmail.data?.configured ? (
        <Button variant="contained" onClick={() => connect.mutate()} disabled={connect.isPending}>Connect Gmail</Button>
      ) : gmail.data && (
        <Alert severity="info">Gmail needs Google OAuth settings before you can connect.</Alert>
      )}
    </Paper>
  );
}

function SourcesCard() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api('/me/sources') });
  const [ref, setRef] = useState('');
  const [kind, setKind] = useState('auto');
  const [schedule, setSchedule] = useState<{ id: string; value: string } | null>(null);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['sources'] });
    qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const add = useMutation({
    mutationFn: () => api('/me/sources', { method: 'POST', json: { ref, ...(kind !== 'auto' ? { kind } : {}) } }),
    onSuccess: () => {
      setRef('');
      invalidate();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/me/sources/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
  const enqueue = useMutation({
    mutationFn: (id: string) => api(`/me/sources/${id}/refresh`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources', 'requests'] }),
  });
  const saveSchedule = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      api(`/me/sources/${id}/schedule`, { method: 'PATCH', json: { times: value.split(',').map((time) => time.trim()).filter(Boolean) } }),
    onSuccess: () => { setSchedule(null); invalidate(); },
  });

  return (
    <Paper className="p-4">
      <Typography variant="h6" component="h2">Job boards</Typography>
      <Typography variant="body2" color="text.secondary" className="mb-3">
        Paste a company board address or a link to one of its postings. Scheduled refreshes run when the server is awake and scheduling is enabled.
      </Typography>
      <Box component="ul" className="mb-3 grid gap-x-4 gap-y-0.5 pl-0 text-sm sm:grid-cols-2" sx={{ listStyle: 'none', color: 'text.secondary' }}>
        {BOARD_FORMATS.map(([name, format]) => (
          <li key={name}>
            <b>{name}</b> <code>{format}</code>
          </li>
        ))}
      </Box>
      <Box
        component="form"
        className="grid gap-2 sm:grid-cols-[1fr_140px_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <TextField label="Board URL or token" value={ref} onChange={(e) => setRef(e.target.value)} required />
        <TextField select label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <MenuItem value="auto">From URL</MenuItem>
          {Object.entries(BOARD_LABEL).map(([value, label]) => (
            <MenuItem key={value} value={value}>{label}</MenuItem>
          ))}
        </TextField>
        <Button type="submit" variant="contained" disabled={add.isPending}>{add.isPending ? 'Checking…' : 'Add'}</Button>
      </Box>
      <Box className="mt-2"><ErrorAlert error={add.error ?? remove.error ?? enqueue.error} /></Box>
      {add.data && <Alert severity="success">Added {add.data.token}: {add.data.jobs} open jobs.</Alert>}
      {sources.isLoading ? (
        <LoadingBlock rows={3} />
      ) : (
        <List dense>
          {(sources.data ?? []).map((s: any) => (
            <ListItem
              key={s.id}
              divider
              secondaryAction={
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <Button size="small" disabled={enqueue.isPending || !s.enabled} onClick={() => enqueue.mutate(s.id)}>Run now</Button>
                  <Button size="small" onClick={() => {
                    saveSchedule.reset();
                    setSchedule({ id: s.id, value: (s.schedule_times ?? []).map((time: string) => time.slice(0, 5)).join(', ') });
                  }}>Schedule</Button>
                  <IconButton edge="end" aria-label={`Remove ${s.company_name || s.token}`} onClick={() => remove.mutate(s.id)}>
                    <Trash2 size={16} />
                  </IconButton>
                </Box>
              }
            >
              <ListItemText
                primary={
                  <>
                    {s.company_name || s.token} <Chip size="small" label={BOARD_LABEL[s.kind] ?? s.kind} variant="outlined" className="ml-1" />
                  </>
                }
                secondary={s.last_error ? `Error: ${s.last_error}` : `${s.open_jobs} open jobs · refreshed ${fmtDateTime(s.last_synced_at)}`}
              />
            </ListItem>
          ))}
        </List>
      )}
      {schedule && (
        <Dialog open fullWidth maxWidth="xs" onClose={() => { if (!saveSchedule.isPending) setSchedule(null); }}>
          <Box component="form" onSubmit={(event) => { event.preventDefault(); saveSchedule.mutate(schedule); }}>
            <DialogTitle>Board refresh schedule</DialogTitle>
            <DialogContent>
              <TextField fullWidth autoFocus margin="dense" label="Times in Berlin" value={schedule.value}
                helperText="Separate HH:mm times with commas. Leave blank to turn off scheduled refreshes."
                onChange={(event) => setSchedule({ ...schedule, value: event.target.value })} />
              <ErrorAlert error={saveSchedule.error} />
            </DialogContent>
            <DialogActions>
              <Button disabled={saveSchedule.isPending} onClick={() => setSchedule(null)}>Cancel</Button>
              <Button type="submit" variant="contained" disabled={saveSchedule.isPending}>Save schedule</Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
      <Typography variant="caption" color="text.secondary" component="p" className="mt-2">
        LinkedIn, Indeed, StepStone and XING forbid automated access, and Workday has no public job feed, so they are not connected.
        Use their e-mail alerts and add the company's own board here when it uses one of the systems above.
      </Typography>
    </Paper>
  );
}

function AiCard() {
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api('/me/profile') });
  const options = useQuery({ queryKey: ['ai-options'], queryFn: () => api('/me/ai/options') });
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    if (profile.data) setS(profile.data.settings);
  }, [profile.data]);
  const save = useMutation({
    mutationFn: () => {
      const { user_id: _u, ...rest } = s;
      return api('/me/settings', { method: 'PUT', json: {
        ...rest, monthly_budget_usd: Number(rest.monthly_budget_usd), daily_budget_usd: Number(rest.daily_budget_usd ?? 1),
      } });
    },
    onSuccess: (d) => qc.setQueryData(['profile'], d),
  });

  if (!s || options.isLoading) return <Paper className="p-4"><LoadingBlock rows={4} /></Paper>;
  if (options.error || !options.data) return <ErrorAlert error={options.error} />;
  const o = options.data;
  const modelChoices: string[] =
    s.ai_provider === 'ollama' ? o.ollama.models : s.ai_provider === 'anthropic' ? o.anthropic.models : [];

  const providerNote: Record<string, string> = {
    none: 'Matching uses free rules only and cover letters use a template built from your profile.',
    ollama: o.ollama.available
      ? `Ollama is running with ${o.ollama.models.length} model(s). Free, runs on this computer.`
      : 'Ollama is not running. Install it from ollama.com, then run for example "ollama pull llama3.2".',
    openai: o.openai.configured ? `Uses ${o.openai.baseUrl}. Any OpenAI-compatible service works.` : 'Set OPENAI_API_KEY in the server .env file first.',
    anthropic: o.anthropic.configured ? 'Claude via the Anthropic API.' : 'Set ANTHROPIC_API_KEY in the server .env file first.',
  };

  return (
    <Paper className="p-4">
      <Typography variant="h6" component="h2" className="mb-3">AI and integrations</Typography>
      <Box className="flex flex-col gap-3">
        <TextField
          select
          label="AI provider"
          value={s.ai_provider}
          onChange={(e) => {
            const p = e.target.value;
            const model = p === 'anthropic' ? 'claude-haiku-5-5' : p === 'ollama' ? (o.ollama.models[0] ?? '') : '';
            setS({ ...s, ai_provider: p, ai_model: model });
          }}
          helperText={providerNote[s.ai_provider]}
        >
          <MenuItem value="none">None (free, rule-based)</MenuItem>
          <MenuItem value="ollama">Ollama (local, free)</MenuItem>
          <MenuItem value="openai">OpenAI-compatible API</MenuItem>
          <MenuItem value="anthropic">Anthropic Claude</MenuItem>
        </TextField>
        {(s.ai_provider === 'openai' || s.ai_provider === 'anthropic') && !o.paidEnabled && (
          <Alert severity="info">Paid requests are disabled on this server. You can save provider settings for later.</Alert>
        )}
        {s.ai_provider === 'ollama' && (
          <FormControlLabel label="Automatically assess top matches with local Ollama (up to three daily)" control={
            <Switch checked={s.auto_assess_local ?? false}
              onChange={(_, checked) => setS({ ...s, auto_assess_local: checked })} />
          } />
        )}
        {s.ai_provider !== 'none' &&
          (modelChoices.length ? (
            <TextField select label="Model" value={s.ai_model} onChange={(e) => setS({ ...s, ai_model: e.target.value })}
              helperText={s.ai_provider === 'anthropic' ? 'Haiku is the cheapest; Sonnet and Opus write better letters at higher cost.' : undefined}>
              {modelChoices.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
            </TextField>
          ) : (
            <TextField label="Model" value={s.ai_model} onChange={(e) => setS({ ...s, ai_model: e.target.value })} placeholder="e.g. gpt-5-mini" />
          ))}
        <TextField
          label="Daily AI budget (USD)"
          type="number"
          value={s.daily_budget_usd ?? 1}
          onChange={(e) => setS({ ...s, daily_budget_usd: e.target.value })}
          helperText="Applies to paid requests. The daily limit resets at midnight in Berlin."
        />
        <TextField
          label="Monthly AI budget (USD)"
          type="number"
          value={s.monthly_budget_usd}
          onChange={(e) => setS({ ...s, monthly_budget_usd: e.target.value })}
          helperText="Paid requests reserve estimated cost before running. Ollama is free."
        />
        <TextField
          label="Resume Builder URL"
          value={s.resume_builder_url}
          onChange={(e) => setS({ ...s, resume_builder_url: e.target.value })}
          helperText="Linked from resume suggestions. Resumes are edited there, never here."
        />
      </Box>
      <ErrorAlert error={save.error} />
      {save.isSuccess && <Alert severity="success" className="mt-3">Saved.</Alert>}
      <Button variant="contained" className="mt-3" onClick={() => save.mutate()} disabled={save.isPending}>Save settings</Button>
    </Paper>
  );
}

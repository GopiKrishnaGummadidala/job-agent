import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Sources & Settings" subtitle="Where jobs come from, which AI to use, and how much it may cost." />
      <Box className="grid gap-4 lg:grid-cols-2">
        <SourcesCard />
        <AiCard />
      </Box>
    </>
  );
}

function SourcesCard() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api('/me/sources') });
  const [ref, setRef] = useState('');
  const [kind, setKind] = useState('auto');
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

  return (
    <Paper className="p-4">
      <Typography variant="h6" component="h2">Job boards</Typography>
      <Typography variant="body2" color="text.secondary" className="mb-3">
        Paste the job board address of a company you want to work for. Supported formats:
        <code className="mx-1">job-boards.greenhouse.io/&lt;company&gt;</code>,
        <code className="mx-1">jobs.lever.co/&lt;company&gt;</code> and
        <code className="mx-1">jobs.ashbyhq.com/&lt;company&gt;</code>
        (e.g. https://jobs.ashbyhq.com/ashby). A link to any job posting on the board works too. Boards refresh every few hours.
      </Typography>
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
          <MenuItem value="greenhouse">Greenhouse</MenuItem>
          <MenuItem value="lever">Lever</MenuItem>
          <MenuItem value="ashby">Ashby</MenuItem>
        </TextField>
        <Button type="submit" variant="contained" disabled={add.isPending}>{add.isPending ? 'Checking…' : 'Add'}</Button>
      </Box>
      <Box className="mt-2"><ErrorAlert error={add.error ?? remove.error} /></Box>
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
                <IconButton edge="end" aria-label={`Remove ${s.company_name || s.token}`} onClick={() => remove.mutate(s.id)}>
                  <Trash2 size={16} />
                </IconButton>
              }
            >
              <ListItemText
                primary={
                  <>
                    {s.company_name || s.token} <Chip size="small" label={s.kind} variant="outlined" className="ml-1" />
                  </>
                }
                secondary={s.last_error ? `Error: ${s.last_error}` : `${s.open_jobs} open jobs · refreshed ${fmtDateTime(s.last_synced_at)}`}
              />
            </ListItem>
          ))}
        </List>
      )}
      <Typography variant="caption" color="text.secondary" component="p" className="mt-2">
        LinkedIn, Indeed, StepStone and XING forbid automated access, so they are not connected. Use their e-mail alerts and apply via the company's own board.
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
      return api('/me/settings', { method: 'PUT', json: { ...rest, monthly_budget_usd: Number(rest.monthly_budget_usd) } });
    },
    onSuccess: (d) => qc.setQueryData(['profile'], d),
  });

  if (!s || options.isLoading) return <Paper className="p-4"><LoadingBlock rows={4} /></Paper>;
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
          label="Monthly AI budget (USD)"
          type="number"
          value={s.monthly_budget_usd}
          onChange={(e) => setS({ ...s, monthly_budget_usd: e.target.value })}
          helperText="Paid AI calls stop when this month's spend reaches the budget. Ollama is not counted."
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

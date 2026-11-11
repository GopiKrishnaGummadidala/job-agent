import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Slider,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, ExternalLink, RefreshCw, Sparkles, X } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api, fmtDate } from '../../lib/api';
import { statusColor, statusLabel } from '../../styles/theme';

export function JobsPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search);
  const [minScore, setMinScore] = useState(40);
  const [status, setStatus] = useState('all');
  const [showFiltered, setShowFiltered] = useState(false);
  const selected = params.get('job');

  const jobs = useQuery({
    queryKey: ['jobs', { q, minScore, status, showFiltered }],
    queryFn: () =>
      api(`/me/jobs?${new URLSearchParams({ q, minScore: String(minScore), status, includeFiltered: String(showFiltered) })}`),
  });
  const sync = useMutation({
    mutationFn: () => api('/me/sources/sync', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const columns: GridColDef[] = [
    {
      field: 'score',
      headerName: 'Match',
      width: 90,
      valueGetter: (_, row) => row.ai_score ?? row.score,
      renderCell: (p) => (
        <Tooltip title={p.row.ai_score != null ? `AI score (rule score ${p.row.score})` : 'Rule-based score'}>
          <Chip size="small" label={p.value} color={p.value >= 70 ? 'success' : p.value >= 40 ? 'warning' : 'default'} icon={p.row.ai_score != null ? <Sparkles size={12} /> : undefined} />
        </Tooltip>
      ),
    },
    { field: 'title', headerName: 'Role', flex: 2, minWidth: 220 },
    { field: 'company', headerName: 'Company', flex: 1, minWidth: 120 },
    { field: 'location', headerName: 'Location', flex: 1, minWidth: 140 },
    { field: 'source', headerName: 'Source', width: 100 },
    { field: 'posted_at', headerName: 'Posted', width: 110, valueFormatter: (v) => fmtDate(v) },
    {
      field: 'draft_status',
      headerName: 'Application',
      width: 150,
      renderCell: (p) =>
        p.value ? (
          <Chip size="small" label={statusLabel[p.value]} color={statusColor[p.value]} variant="outlined" />
        ) : p.row.status === 'saved' ? (
          <Chip size="small" label="Saved" variant="outlined" />
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Job Explorer"
        subtitle="Jobs from your boards, ranked by rule-based match. Use AI assessment on the ones worth a closer look."
        actions={
          <Button startIcon={<RefreshCw size={16} />} onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Refreshing…' : 'Refresh boards'}
          </Button>
        }
      />
      {sync.data?.errors?.length > 0 && <Alert severity="warning" className="mb-3">{sync.data.errors.join(' ')}</Alert>}
      <ErrorAlert error={sync.error} />
      <Paper className="mb-3 grid gap-4 p-4 md:grid-cols-[2fr_1.4fr_1fr_auto] md:items-center">
        <TextField label="Search role or company" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Box className="px-2">
          <Typography variant="caption" color="text.secondary" id="min-score-label">
            Minimum match: {minScore}
          </Typography>
          <Slider size="small" value={minScore} onChange={(_, v) => setMinScore(v as number)} min={0} max={100} step={5} aria-labelledby="min-score-label" />
        </Box>
        <TextField select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <MenuItem value="all">All but dismissed</MenuItem>
          <MenuItem value="new">New</MenuItem>
          <MenuItem value="saved">Saved</MenuItem>
          <MenuItem value="dismissed">Dismissed</MenuItem>
        </TextField>
        <FormControlLabel control={<Switch checked={showFiltered} onChange={(e) => setShowFiltered(e.target.checked)} />} label="Show filtered out" />
      </Paper>
      {jobs.isLoading ? (
        <LoadingBlock rows={8} />
      ) : jobs.error ? (
        <ErrorAlert error={jobs.error} />
      ) : jobs.data.length === 0 && !q && minScore <= 40 && status === 'all' ? (
        <EmptyState title="No jobs yet" action={<Button component={RouterLink} to="/settings" variant="contained">Add a job board</Button>}>
          Add Greenhouse, Lever or Ashby boards of companies you like. Jobs are fetched from their public job APIs.
        </EmptyState>
      ) : (
        <Paper sx={{ height: 'calc(100vh - 330px)', minHeight: 420 }}>
          <DataGrid
            rows={jobs.data}
            columns={columns}
            density="compact"
            disableRowSelectionOnClick
            onRowClick={(p) => setParams({ job: String(p.id) })}
            initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
            pageSizeOptions={[25, 50, 100]}
            sx={{ border: 0, '& .MuiDataGrid-row': { cursor: 'pointer' } }}
          />
        </Paper>
      )}
      <Drawer anchor="right" open={!!selected} onClose={() => setParams({})} slotProps={{ paper: { sx: { width: { xs: '100%', sm: 560 } } } }}>
        {selected && <JobDetail id={selected} onClose={() => setParams({})} />}
      </Drawer>
    </>
  );
}

function JobDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const job = useQuery({ queryKey: ['job', id], queryFn: () => api(`/me/jobs/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['job', id] });
    qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const assess = useMutation({ mutationFn: () => api(`/me/jobs/${id}/assess`, { method: 'POST' }), onSuccess: refresh });
  const setStatus = useMutation({
    mutationFn: (status: string) => api(`/me/jobs/${id}/status`, { method: 'PATCH', json: { status } }),
    onSuccess: refresh,
  });
  const prepare = useMutation({
    mutationFn: () => api(`/me/jobs/${id}/prepare`, { method: 'POST' }),
    onSuccess: (d) => {
      refresh();
      navigate(`/approvals/${d.id}`);
    },
  });

  if (job.isLoading) return <Box className="p-6"><LoadingBlock /></Box>;
  if (job.error) return <Box className="p-6"><ErrorAlert error={job.error} /></Box>;
  const j = job.data;
  const ai = j.ai_assessment;
  const rec = j.resume;

  return (
    <Box className="flex h-full flex-col">
      <Box className="flex items-start gap-2 p-4">
        <Box className="min-w-0 flex-1">
          <Typography variant="h6" component="h2">{j.title}</Typography>
          <Typography color="text.secondary">
            {j.company} · {j.location || 'Location not stated'} {j.remote && '· Remote'}
          </Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="Close"><X size={18} /></IconButton>
      </Box>
      <Box className="flex flex-wrap gap-2 px-4 pb-3">
        {j.draft_id ? (
          <Button variant="contained" component={RouterLink} to={`/approvals/${j.draft_id}`}>Open application</Button>
        ) : (
          <Button variant="contained" onClick={() => prepare.mutate()} disabled={prepare.isPending || !!j.closed_at}>
            {prepare.isPending ? 'Preparing…' : 'Prepare application'}
          </Button>
        )}
        <Button startIcon={<Sparkles size={16} />} onClick={() => assess.mutate()} disabled={assess.isPending}>
          {assess.isPending ? 'Assessing…' : ai && j.ai_current ? 'AI assessed' : 'AI assessment'}
        </Button>
        <Button startIcon={<Bookmark size={16} />} onClick={() => setStatus.mutate(j.status === 'saved' ? 'new' : 'saved')}>
          {j.status === 'saved' ? 'Unsave' : 'Save'}
        </Button>
        <Button color="inherit" onClick={() => setStatus.mutate(j.status === 'dismissed' ? 'new' : 'dismissed')}>
          {j.status === 'dismissed' ? 'Restore' : 'Dismiss'}
        </Button>
        <Button component="a" href={j.url} target="_blank" rel="noreferrer" endIcon={<ExternalLink size={14} />}>Posting</Button>
      </Box>
      <Box className="px-4">
        <ErrorAlert error={prepare.error ?? assess.error} />
        {assess.data?.error && <Alert severity="warning" className="mb-3">{assess.data.error}</Alert>}
      </Box>
      <Divider />
      <Box className="flex-1 overflow-y-auto p-4">
        <Typography variant="subtitle2" gutterBottom>Why it matched · {j.score}/100</Typography>
        {j.reasons.map((r: any) => (
          <Typography key={r.label} variant="body2" className="mb-1">
            <b>{r.label}</b> {r.max ? `${r.points}/${r.max}` : ''} — {r.detail}
          </Typography>
        ))}
        {j.unknowns.length > 0 && (
          <Typography variant="body2" color="text.secondary" className="mt-1">Unknown: {j.unknowns.join(' ')}</Typography>
        )}

        {ai && (
          <Paper className="mt-4 p-3">
            <Typography variant="subtitle2">
              AI assessment · {ai.score}/100 <Typography component="span" variant="caption" color="text.secondary">({ai.model}{j.ai_current ? '' : ', posting changed since'})</Typography>
            </Typography>
            <Typography variant="body2" className="mt-1">{ai.summary}</Typography>
            {(['strengths', 'gaps', 'unknowns'] as const).map((k) =>
              ai[k]?.length ? (
                <Typography key={k} variant="body2" className="mt-1">
                  <b className="capitalize">{k}:</b> {ai[k].join('; ')}
                </Typography>
              ) : null,
            )}
            <Typography variant="caption" color="text.secondary" component="p" className="mt-2">
              AI recommendation, not verified fact.
            </Typography>
          </Paper>
        )}

        <Paper className="mt-4 p-3">
          <Typography variant="subtitle2">Resume suggestion</Typography>
          {rec.resumeId ? (
            <>
              <Typography variant="body2" className="mt-1">
                Best existing resume: <b>{rec.filename}</b>{rec.matched.length > 0 && ` — mentions ${rec.matched.join(', ')}`}.
              </Typography>
              {rec.missing.length > 0 && (
                <Typography variant="body2" className="mt-1">
                  The posting asks for <b>{rec.missing.join(', ')}</b>, which your profile lists but this resume does not mention.
                  {j.resume_builder_url ? (
                    <> Consider adding it in <Link href={j.resume_builder_url} target="_blank" rel="noreferrer">Resume Builder</Link>, then upload the new version.</>
                  ) : ' Consider adding it in your resume builder, then upload the new version.'}
                </Typography>
              )}
            </>
          ) : (
            <Typography variant="body2" className="mt-1">
              No resumes yet. <Link component={RouterLink} to="/resumes">Upload one</Link>.
            </Typography>
          )}
        </Paper>

        <Typography variant="subtitle2" className="mt-4" gutterBottom>Description</Typography>
        <Typography variant="body2" className="prewrap" color="text.secondary">{j.description || 'No description provided.'}</Typography>
      </Box>
    </Box>
  );
}

import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  Link,
  ListItemText,
  MenuItem,
  Paper,
  Slider,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, ExternalLink, FilterX, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { BOARD_LABEL } from '../../lib/boards';
import { statusColor, statusLabel } from '../../styles/theme';

const POSTED = [
  { value: 'any', label: 'Any time' },
  { value: '1d', label: 'Past 24 hours' },
  { value: '3d', label: 'Past 3 days' },
  { value: '7d', label: 'Past week' },
  { value: '14d', label: 'Past 2 weeks' },
  { value: '30d', label: 'Past month' },
];

export const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract / freelance',
  temporary: 'Temporary',
  internship: 'Internship',
  working_student: 'Working student',
};
export const WORKPLACE_LABEL: Record<string, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };
const SENIORITY_LABEL: Record<string, string> = {
  intern: 'Intern / student',
  junior: 'Junior',
  mid: 'Mid-level',
  senior: 'Senior',
  staff: 'Staff / principal',
  lead: 'Lead / manager',
};
const SOURCE_LABEL = BOARD_LABEL;

/** URL keys for list filters; each value is a repeated search parameter. */
const LIST_KEYS = ['country', 'type', 'workplace', 'seniority', 'source', 'company', 'tags'] as const;
const FILTER_KEYS = ['q', 'loc', 'posted', 'min', 'status', 'hidden', 'tagMode', ...LIST_KEYS];

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
/** "DE" → "Germany"; "EU" is a Europe-wide posting. */
export function countryName(code: string) {
  if (code === 'EU') return 'Europe-wide';
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

interface Facet {
  value: string;
  n: number;
}

function ago(v: string) {
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function MultiSelect({
  label,
  value,
  onChange,
  labels,
  facets,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  labels: Record<string, string>;
  facets?: Facet[];
}) {
  const count = (v: string) => facets?.find((f) => f.value === v)?.n ?? 0;
  return (
    <TextField
      select
      label={label}
      value={value}
      onChange={(e) => {
        const v = e.target.value as unknown as string[] | string;
        onChange(typeof v === 'string' ? v.split(',') : v);
      }}
      slotProps={{
        inputLabel: { shrink: true },
        select: {
          multiple: true,
          displayEmpty: true,
          renderValue: (sel) => {
            const s = sel as string[];
            return s.length ? s.map((v) => labels[v] ?? v).join(', ') : <span className="opacity-60">Any</span>;
          },
        },
      }}
    >
      {Object.entries(labels).map(([v, l]) => (
        <MenuItem key={v} value={v} dense>
          <Checkbox size="small" checked={value.includes(v)} sx={{ py: 0 }} />
          <ListItemText primary={l} secondary={facets ? `${count(v)} jobs` : undefined} />
        </MenuItem>
      ))}
    </TextField>
  );
}

export function JobsPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api('/me/profile') });
  const defaultMin = profile.data?.preferences.min_score ?? 40;

  const get = (k: string, d = '') => params.get(k) ?? d;
  const getList = (k: string) => params.getAll(k);
  const minScore = Number(get('min', String(defaultMin)));
  const [minDraft, setMinDraft] = useState(minScore);
  useEffect(() => setMinDraft(minScore), [minScore]);
  const selected = params.get('job');

  /** Updates filters in the URL; empty values are removed so links stay short. */
  const update = (patch: Record<string, string | string[] | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          next.delete(k);
          if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
          else if (v) next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  const clearFilters = () => update(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])));
  const activeFilters = FILTER_KEYS.filter((k) => params.has(k)).length;

  const apiQuery = useMemo(() => {
    const s = new URLSearchParams();
    s.set('minScore', String(minScore));
    s.set('status', get('status', 'all'));
    s.set('posted', get('posted', 'any'));
    s.set('includeFiltered', String(get('hidden') === '1'));
    s.set('tagMode', get('tagMode', 'any'));
    if (get('q')) s.set('q', get('q'));
    if (get('loc')) s.set('location', get('loc'));
    for (const k of LIST_KEYS) getList(k).forEach((v) => s.append(k, v));
    return s.toString();
  }, [params, minScore]); // eslint-disable-line react-hooks/exhaustive-deps

  const jobs = useQuery({ queryKey: ['jobs', apiQuery], queryFn: () => api<any[]>(`/me/jobs?${apiQuery}`), enabled: !profile.isLoading });
  const facets = useQuery({ queryKey: ['jobs', 'facets', minScore], queryFn: () => api(`/me/jobs/facets?minScore=${minScore}`) });
  const tagOptions = useQuery({ queryKey: ['resume-tags'], queryFn: () => api<{ tag: string; resumes: number }[]>('/me/resumes/tags') });
  const sync = useMutation({
    mutationFn: () => api('/me/sources/sync', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const tags = getList('tags');
  const f = facets.data;
  // Countries with jobs, most first; a selected country stays listed even when its count is 0.
  const countryLabels = useMemo(() => {
    const codes = [...new Set([...(f?.country ?? []).map((c: Facet) => c.value), ...getList('country')])] as string[];
    return Object.fromEntries(codes.map((c) => [c, countryName(c)]));
  }, [f, params]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns: GridColDef[] = [
    {
      field: 'score',
      headerName: 'Match',
      width: 80,
      valueGetter: (_, row) => row.ai_score ?? row.score,
      renderCell: (p) => (
        <Tooltip title={p.row.ai_score != null ? `AI score (rule score ${p.row.score})` : 'Rule-based score'}>
          <Chip size="small" label={p.value} color={p.value >= 70 ? 'success' : p.value >= 40 ? 'warning' : 'default'} icon={p.row.ai_score != null ? <Sparkles size={12} /> : undefined} />
        </Tooltip>
      ),
    },
    { field: 'title', headerName: 'Role', flex: 2, minWidth: 220 },
    { field: 'company', headerName: 'Company', flex: 1, minWidth: 110 },
    { field: 'location', headerName: 'Location', flex: 1, minWidth: 130 },
    { field: 'workplace', headerName: 'Workplace', width: 100, valueFormatter: (v) => WORKPLACE_LABEL[v] ?? v },
    { field: 'employment_type', headerName: 'Type', width: 120, valueFormatter: (v) => EMPLOYMENT_LABEL[v] ?? v },
    {
      field: 'tag_hits',
      headerName: 'CV tags',
      width: 140,
      sortable: false,
      renderCell: (p) => (
        <Box className="flex h-full items-center gap-1 overflow-hidden">
          {(p.value as string[]).map((t) => (
            <Chip key={t} size="small" label={t} variant={tags.includes(t) ? 'filled' : 'outlined'} />
          ))}
        </Box>
      ),
    },
    {
      field: 'posted',
      headerName: 'Posted',
      width: 110,
      valueGetter: (_, row) => row.posted_at ?? row.first_seen_at,
      valueFormatter: (v) => ago(v),
    },
    {
      field: 'draft_status',
      headerName: 'Application',
      width: 140,
      renderCell: (p) =>
        p.value ? (
          <Chip size="small" label={statusLabel[p.value]} color={statusColor[p.value]} variant="outlined" />
        ) : p.row.status === 'saved' ? (
          <Chip size="small" label="Saved" variant="outlined" />
        ) : null,
    },
  ];

  const noBoards = f && f.sources === 0;

  return (
    <>
      <PageHeader
        title="Job Explorer"
        subtitle="Jobs from your boards, ranked by rule-based match. Use AI assessment on the ones worth a closer look."
        actions={
          <Button startIcon={<RefreshCw size={16} />} onClick={() => sync.mutate()} disabled={sync.isPending || noBoards}>
            {sync.isPending ? 'Refreshing…' : 'Refresh boards'}
          </Button>
        }
      />
      {sync.data?.errors?.length > 0 && <Alert severity="warning" className="mb-3">{sync.data.errors.join(' ')}</Alert>}
      <ErrorAlert error={sync.error} />
      {f?.profile_incomplete && !noBoards && (
        <Alert
          severity="info"
          className="mb-3"
          action={<Button component={RouterLink} to="/profile" color="inherit" size="small">Complete profile</Button>}
        >
          Your profile has no target roles or skills yet, so jobs cannot be ranked (most score 30–40 and many are hidden below the minimum match). Add them to rank jobs properly.
        </Alert>
      )}

      {noBoards ? (
        <EmptyState title="No job boards yet" action={<Button component={RouterLink} to="/settings" variant="contained">Add a job board</Button>}>
          Job Explorer searches the boards you add. Paste a company's careers page from Greenhouse, Lever or Ashby in Sources &amp; Settings,
          for example https://job-boards.greenhouse.io/gitlab.
        </EmptyState>
      ) : (
        <>
          <Paper className="mb-3 flex flex-col gap-3 p-4">
            <Box className="grid gap-3 md:grid-cols-[2fr_1fr_1.2fr_1fr]">
              <TextField label="Search role, company or location" value={get('q')} onChange={(e) => update({ q: e.target.value })} />
              <TextField select label="Date posted" value={get('posted', 'any')} onChange={(e) => update({ posted: e.target.value === 'any' ? null : e.target.value })}>
                {POSTED.map((p) => (
                  <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>
                ))}
              </TextField>
              <Box className="px-2">
                <Typography variant="caption" color="text.secondary" id="min-score-label">
                  Minimum match: {minDraft}
                </Typography>
                <Slider
                  size="small"
                  value={minDraft}
                  onChange={(_, v) => setMinDraft(v as number)}
                  onChangeCommitted={(_, v) => update({ min: v === defaultMin ? null : String(v) })}
                  min={0}
                  max={100}
                  step={5}
                  aria-labelledby="min-score-label"
                />
              </Box>
              <TextField select label="Status" value={get('status', 'all')} onChange={(e) => update({ status: e.target.value === 'all' ? null : e.target.value })}>
                <MenuItem value="all">All but dismissed</MenuItem>
                <MenuItem value="new">New</MenuItem>
                <MenuItem value="saved">Saved</MenuItem>
                <MenuItem value="dismissed">Dismissed</MenuItem>
              </TextField>
            </Box>
            <Box className="grid gap-3 sm:grid-cols-2">
              <MultiSelect label="Country" value={getList('country')} onChange={(v) => update({ country: v })} labels={countryLabels} facets={f?.country} />
              <TextField
                label="City or region"
                value={get('loc')}
                onChange={(e) => update({ loc: e.target.value })}
                placeholder="e.g. Hamburg"
                helperText={getList('country').length ? 'Countries in Europe also include Europe-wide remote jobs.' : undefined}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Box>
            <Box className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <MultiSelect label="Employment type" value={getList('type')} onChange={(v) => update({ type: v })} labels={EMPLOYMENT_LABEL} facets={f?.employment_type} />
              <MultiSelect label="Workplace" value={getList('workplace')} onChange={(v) => update({ workplace: v })} labels={WORKPLACE_LABEL} facets={f?.workplace} />
              <MultiSelect label="Seniority" value={getList('seniority')} onChange={(v) => update({ seniority: v })} labels={SENIORITY_LABEL} facets={f?.seniority} />
              <MultiSelect label="Source" value={getList('source')} onChange={(v) => update({ source: v })} labels={SOURCE_LABEL} facets={f?.source} />
              <Autocomplete
                multiple
                limitTags={1}
                options={(f?.company ?? []).map((c: Facet) => c.value)}
                getOptionLabel={(o) => `${o} (${f?.company.find((c: Facet) => c.value === o)?.n ?? 0})`}
                value={getList('company')}
                onChange={(_, v) => update({ company: v })}
                renderValue={(vals, getItemProps) =>
                  vals.map((o, index) => {
                    const { key, ...rest } = getItemProps({ index });
                    return <Chip key={key} size="small" label={o} {...rest} />;
                  })
                }
                renderInput={(p) => <TextField {...p} label="Company" placeholder={getList('company').length ? '' : 'Any'} slotProps={{ ...p.slotProps, inputLabel: { shrink: true } }} />}
              />
            </Box>
            <Box className="flex flex-wrap items-center gap-3">
              {tagOptions.data?.length ? (
                <>
                  <Autocomplete
                    multiple
                    className="min-w-64 flex-1"
                    options={tagOptions.data.map((t) => t.tag)}
                    value={tags}
                    onChange={(_, v) => update({ tags: v })}
                    renderInput={(p) => <TextField {...p} label="CV tags" placeholder={tags.length ? '' : 'e.g. .NET, Node, Angular'} />}
                  />
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={get('tagMode', 'any')}
                    onChange={(_, v) => v && update({ tagMode: v === 'any' ? null : v })}
                    aria-label="How to combine tags"
                    disabled={tags.length < 2}
                  >
                    <ToggleButton value="any">Any tag</ToggleButton>
                    <ToggleButton value="all">All tags</ToggleButton>
                  </ToggleButtonGroup>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" className="flex-1">
                  Tag your CVs (e.g. .NET, Node, Angular) in the <Link component={RouterLink} to="/resumes">Resume Library</Link> to filter jobs by them.
                </Typography>
              )}
              <FormControlLabel
                control={<Switch checked={get('hidden') === '1'} onChange={(e) => update({ hidden: e.target.checked ? '1' : null })} />}
                label="Include jobs my preferences filter out"
              />
              <Button startIcon={<FilterX size={16} />} onClick={clearFilters} disabled={!activeFilters}>
                Clear filters{activeFilters ? ` (${activeFilters})` : ''}
              </Button>
            </Box>
          </Paper>

          {jobs.isLoading || profile.isLoading ? (
            <LoadingBlock rows={8} />
          ) : jobs.error ? (
            <ErrorAlert error={jobs.error} />
          ) : jobs.data!.length === 0 ? (
            <EmptyState
              title={f?.total_open === 0 ? 'Your boards have no open jobs' : 'No jobs match these filters'}
              action={
                f?.total_open === 0 ? (
                  <Button variant="contained" onClick={() => sync.mutate()} disabled={sync.isPending}>Refresh boards</Button>
                ) : (
                  <Box className="flex flex-wrap justify-center gap-2">
                    {activeFilters > 0 && <Button variant="contained" onClick={clearFilters}>Clear filters</Button>}
                    {f?.below_score > 0 && minScore > 0 && <Button onClick={() => update({ min: '0' })}>Show all match scores</Button>}
                    {f?.filtered_out > 0 && get('hidden') !== '1' && <Button onClick={() => update({ hidden: '1' })}>Include filtered-out jobs</Button>}
                  </Box>
                )
              }
            >
              {f && f.total_open > 0 && (
                <>
                  Your boards have {f.total_open} open jobs. {f.below_score > 0 && `${f.below_score} score below your minimum match of ${minScore}. `}
                  {f.filtered_out > 0 && `${f.filtered_out} are excluded by your location or keyword preferences. `}
                  The other filters above narrow it further.
                </>
              )}
              {f?.total_open === 0 && 'Refresh to fetch the latest postings, or add more boards in Sources & Settings.'}
            </EmptyState>
          ) : (
            <Paper sx={{ height: 'calc(100vh - 400px)', minHeight: 420 }}>
              <DataGrid
                rows={jobs.data}
                columns={columns}
                density="compact"
                disableRowSelectionOnClick
                onRowClick={(p) => update({ job: String(p.id) })}
                initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
                pageSizeOptions={[25, 50, 100]}
                sx={{ border: 0, '& .MuiDataGrid-row': { cursor: 'pointer' } }}
              />
            </Paper>
          )}
        </>
      )}
      <Drawer anchor="right" open={!!selected} onClose={() => update({ job: null })} slotProps={{ paper: { sx: { width: { xs: '100%', sm: 560 } } } }}>
        {selected && <JobDetail id={selected} onClose={() => update({ job: null })} />}
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
            {j.company} · {j.location || 'Location not stated'}
          </Typography>
          <Box className="mt-1 flex flex-wrap gap-1">
            <Chip size="small" label={WORKPLACE_LABEL[j.workplace] ?? j.workplace} />
            <Chip size="small" label={EMPLOYMENT_LABEL[j.employment_type] ?? j.employment_type} />
            <Chip size="small" label={SENIORITY_LABEL[j.seniority] ?? j.seniority} />
            <Chip size="small" variant="outlined" label={`Posted ${ago(j.posted_at ?? j.first_seen_at).toLowerCase()}`} />
          </Box>
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
                Best existing CV: <b>{rec.filename}</b>
                {rec.tagHits.length > 0 && <> — tagged {rec.tagHits.join(', ')}, which this job asks for</>}
                {rec.tagHits.length === 0 && rec.matched.length > 0 && ` — mentions ${rec.matched.join(', ')}`}.
              </Typography>
              {rec.tags.length > 0 && (
                <Box className="mt-1 flex flex-wrap gap-1">
                  {rec.tags.map((t: string) => (
                    <Chip key={t} size="small" label={t} color={rec.tagHits.includes(t) ? 'primary' : 'default'} variant="outlined" />
                  ))}
                </Box>
              )}
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

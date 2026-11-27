import {
  Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Paper, Tab, Table, TableBody, TableCell, TableContainer, TextField,
  TableHead, TablePagination, TableRow, Tabs, Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { WorkspaceAccess, useWorkspace } from '../workspace/WorkspaceAccess';
import { api, fmtDateTime } from '../../lib/api';

const sections = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'indeed', label: 'Indeed' },
  { id: 'glassdoor', label: 'Glassdoor' },
  { id: 'stepstone', label: 'StepStone' },
  { id: 'manual', label: 'Saved Links' },
];
const statuses = { pending: 'Pending', viewed: 'Viewed', applied: 'Applied', interviewed: 'Interviewed', unfit: 'Unfit' } as const;
const statusColors = { pending: 'default', viewed: 'info', applied: 'success', interviewed: 'secondary', unfit: 'warning' } as const;
type JobStatus = keyof typeof statuses;
type JobLinkForm = { id?: string; url: string; title: string; company: string };

export function EmailManagementPage() {
  const { provider } = useParams();
  const [workspace] = useWorkspace();
  const section = sections.find((item) => item.id === provider);
  if (!section) return <Navigate to="/email/linkedin" replace />;
  return (
    <>
      <PageHeader title="Email Management" subtitle="Import Gmail job alerts and track your saved job links." />
      <WorkspaceAccess />
      <JobActivity workspace={workspace} />
      <Paper variant="outlined" className="mb-4">
        <Tabs value={section.id} aria-label="Job sources" variant="scrollable" scrollButtons="auto">
          {sections.map((item) => (
            <Tab key={item.id} value={item.id} label={item.label} component={RouterLink}
              to={'/email/' + item.id + (workspace ? '?' + new URLSearchParams({ workspace }) : '')} />
          ))}
        </Tabs>
      </Paper>
      <WorkspaceJobs section={section} />
    </>
  );
}

function WorkspaceJobs({ section }: { section: typeof sections[number] }) {
  const [workspace] = useWorkspace();
  return <GmailJobs key={section.id + workspace} section={section} workspace={workspace} />;
}

const activityKey = (workspace: string) => ['gmail-job-activity', workspace];
const dayLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function JobActivity({ workspace }: { workspace: string }) {
  const activity = useQuery({
    queryKey: activityKey(workspace),
    queryFn: () => api<{
      totals: { status: JobStatus; count: number }[];
      daily: { day: string; count: number }[];
    }>('/me/gmail/jobs/activity' + (workspace ? '?' + new URLSearchParams({ workspace }) : '')),
    refetchInterval: 60_000,
  });
  const daily = activity.data?.daily ?? [];
  const peak = Math.max(1, ...daily.map(({ count }) => count));

  return (
    <Paper variant="outlined" sx={{ mb: 2, p: 2 }}>
      <Typography variant="h6" component="h2">Job activity</Typography>
      <Typography variant="body2" color="text.secondary">
        Across job alerts and saved links in this workspace
      </Typography>
      <ErrorAlert error={activity.error} />
      {activity.isPending && <LoadingBlock />}
      {activity.data && (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 1, my: 2 }}>
            {(Object.keys(statuses) as JobStatus[]).map((status) => (
              <Box key={status} sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.5 }}>
                <Chip size="small" color={statusColors[status]} label={statuses[status]} />
                <Typography variant="h5" sx={{ mt: 0.5 }}>
                  {activity.data?.totals.find((total) => total.status === status)?.count ?? 0}
                </Typography>
              </Box>
            ))}
          </Box>
          <Typography variant="subtitle1" component="h3">Applications per day</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Jobs currently marked Applied, grouped by the day they were marked over the last 14 days (Berlin time).
          </Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <Box component="ul" aria-label="Daily application counts" sx={{
              display: 'grid', gridTemplateColumns: 'repeat(14, minmax(42px, 1fr))', gap: 0.5,
              minWidth: 640, listStyle: 'none', m: 0, p: 0,
            }}>
              {daily.map(({ day, count }) => (
                <Box component="li" key={day} sx={{ textAlign: 'center', minWidth: 0 }}>
                  <Box sx={{ height: 100, display: 'flex', flexDirection: 'column', justifyContent: 'end', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
                    <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>{count}</Typography>
                    <Box aria-hidden="true" sx={{ width: '65%', maxWidth: 32, height: 76 * count / peak, bgcolor: 'success.main', borderRadius: '4px 4px 0 0' }} />
                  </Box>
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                    {dayLabel.format(new Date(day))}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        </>
      )}
    </Paper>
  );
}

function GmailJobs({ section, workspace }: { section: typeof sections[number]; workspace: string }) {
  const [params, setParams] = useSearchParams();
  const posting = params.get('posting');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [statusFilter, setStatusFilter] = useState('all');
  const [markRead, setMarkRead] = useState(false);
  const [form, setForm] = useState<JobLinkForm | null>(null);
  const manual = section.id === 'manual';
  const filter = '?' + new URLSearchParams({ provider: section.id, ...(workspace ? { workspace } : {}) });
  const jobKey = ['gmail-jobs', section.id, workspace];
  const qc = useQueryClient();
  const refreshJobs = () => Promise.all([
    qc.invalidateQueries({ queryKey: jobKey }),
    qc.invalidateQueries({ queryKey: activityKey(workspace) }),
    qc.invalidateQueries({ queryKey: ['jobs'] }),
  ]);
  const connection = useQuery({
    queryKey: ['gmail'],
    enabled: !manual,
    queryFn: () => api<{ configured: boolean; connection: { email: string } | null }>('/me/gmail'),
  });
  const jobs = useQuery({
    queryKey: jobKey,
    queryFn: () => api<{
      external_id: string; title: string | null; company: string | null; received_at: string; url: string;
      status: JobStatus; status_at?: string; status_actor?: string;
      viewers: { email: string; viewed_at: string }[];
    }[]>('/me/gmail/jobs' + filter),
  });
  const run = useMutation({
    mutationFn: (mode: 'incremental' | 'unread' | 'recent') => api<{
      alertsSaved: number; jobsAdded: number; unreadRetained: number; markedRead: number; alreadyProcessed: number;
      failed: number; checkpointAdvanced: boolean;
    }>('/me/gmail/jobs/import' + filter + (mode === 'incremental' ? '&incremental=true' : mode === 'recent' ? '&includeRead=true' : '') + (markRead ? '&markRead=true' : ''), {
      method: 'POST',
    }),
    onSettled: refreshJobs,
  });
  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: JobStatus }) =>
      api('/me/gmail/jobs/' + encodeURIComponent(id) + '/status', {
        method: 'PATCH', json: { provider: section.id, status, ...(workspace ? { workspace } : {}) },
      }),
    scope: { id: 'gmail-job-status-' + section.id },
    onSuccess: refreshJobs,
  });
  const saveLink = useMutation({
    mutationFn: ({ id, ...details }: JobLinkForm) =>
      api('/me/gmail/jobs/manual' + (id ? '/' + encodeURIComponent(id) : ''), {
        method: id ? 'PATCH' : 'POST',
        json: { ...details, ...(workspace ? { workspace } : {}) },
      }),
    onSuccess: async (_job, fields) => {
      setForm(null);
      if (!fields.id) {
        setPage(0);
        setStatusFilter('all');
      }
      await refreshJobs();
    },
  });
  const openForm = (fields: JobLinkForm) => {
    saveLink.reset();
    setForm(fields);
  };
  const rows = (jobs.data ?? []).filter((job) => posting ? job.external_id === posting : statusFilter === 'all' || job.status === statusFilter);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Box className="flex flex-wrap items-center justify-between gap-2 p-4">
        <Typography variant="h6" component="h2">{manual ? 'Saved job links' : section.label + ' jobs'}</Typography>
        {manual ? (
          <Button variant="contained" onClick={() => openForm({ url: '', title: '', company: '' })}>Add job link</Button>
        ) : !workspace && (connection.data?.connection && connection.data.configured ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <FormControlLabel label="Mark imported alerts as read" control={
              <Checkbox checked={markRead} disabled={run.isPending} onChange={(_, checked) => setMarkRead(checked)} />
            } />
            <Button variant="contained" onClick={() => run.mutate('incremental')} disabled={run.isPending}>
              {run.isPending && run.variables === 'incremental' ? 'Syncing…' : 'Sync new alerts'}
            </Button>
            <Button variant="outlined" onClick={() => run.mutate('unread')} disabled={run.isPending}>
              {run.isPending && run.variables === 'unread' ? 'Importing…' : 'Import unread alerts'}
            </Button>
            <Button variant="outlined" onClick={() => run.mutate('recent')} disabled={run.isPending}>
              {run.isPending && run.variables === 'recent' ? 'Importing…' : 'Import last 30 days'}
            </Button>
          </Box>
        ) : connection.data && (
          <Button component={RouterLink} to="/settings">Gmail settings</Button>
        ))}
      </Box>
      {form && (
        <Dialog open fullWidth maxWidth="sm" onClose={() => { if (!saveLink.isPending) setForm(null); }}>
          <Box component="form" onSubmit={(event) => { event.preventDefault(); saveLink.mutate(form); }}>
            <DialogTitle>{form.id ? 'Edit job link' : 'Add job link'}</DialogTitle>
            <DialogContent sx={{ display: 'grid', gap: 2, pt: '12px !important' }}>
              <TextField autoFocus required label="Job URL" type="url" value={form.url} disabled={saveLink.isPending}
                onChange={(event) => setForm({ ...form, url: event.target.value })} />
              <TextField required label="Job title" value={form.title} disabled={saveLink.isPending}
                onChange={(event) => setForm({ ...form, title: event.target.value })} />
              <TextField label="Company" value={form.company} disabled={saveLink.isPending}
                onChange={(event) => setForm({ ...form, company: event.target.value })} />
              <ErrorAlert error={saveLink.error} />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setForm(null)} disabled={saveLink.isPending}>Cancel</Button>
              <Button type="submit" variant="contained" disabled={saveLink.isPending}>Save job</Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
      <Box sx={{ px: 2, pb: 2 }}>
        {posting && <Button onClick={() => {
          setParams((previous) => { const next = new URLSearchParams(previous); next.delete('posting'); return next; }, { replace: true });
          setPage(0);
        }}>Show all jobs</Button>}
        <TextField select size="small" label="Filter by status" value={statusFilter} sx={{ minWidth: 155 }}
          disabled={Boolean(posting)}
          onChange={(event) => { setStatusFilter(event.target.value); setPage(0); }}>
          <MenuItem value="all">All statuses</MenuItem>
          {Object.entries(statuses).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
        </TextField>
        <ErrorAlert error={connection.error ?? jobs.error ?? run.error ?? changeStatus.error} />
      </Box>
      {run.data && (
        <Alert sx={{ mx: 2, mb: 2 }} severity={run.data.unreadRetained || run.data.failed ? 'warning' : 'success'}>
          Added {run.data.jobsAdded} jobs from {run.data.alertsSaved} alerts processed.
          {run.data.alreadyProcessed > 0 && ` Skipped ${run.data.alreadyProcessed} previously imported alerts.`}
          {run.data.failed > 0 && ` ${run.data.failed} messages could not be processed.`}
          {run.variables === 'incremental' && (run.data.checkpointAdvanced
            ? ' Sync progress saved.' : ' The next sync will retry this window.')}
          {run.data.markedRead > 0 && ` Marked ${run.data.markedRead} alerts as read in Gmail.`}
          {run.data.unreadRetained > 0 && ` ${run.data.unreadRetained} alerts stayed unread for review.`}
        </Alert>
      )}
      {jobs.isLoading && <LoadingBlock rows={2} />}
      {jobs.data?.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>
          {manual ? 'No job links saved yet.' : 'No ' + section.label + ' jobs imported yet.'}
        </Typography>
      )}
      {!!jobs.data?.length && rows.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>No jobs match this status.</Typography>
      )}
      {rows.length > 0 && (
        <>
          <TableContainer sx={{ borderTop: 1, borderColor: 'divider' }}>
            <Table size="small" aria-label={manual ? 'Saved job links' : section.label + ' imported jobs'}>
              <TableHead sx={{ bgcolor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>Job title</TableCell>
                  <TableCell sx={{ fontWeight: 700, display: { xs: 'none', sm: 'table-cell' } }}>{manual ? 'Date added' : 'Alert received'}</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>Action</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((job) => (
                  <TableRow hover key={job.external_id} sx={{ '& td, & th': { py: 1 } }}>
                    <TableCell scope="row" component="th" sx={{ overflowWrap: 'anywhere' }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{job.title ?? section.label + ' job'}</Typography>
                      {job.company && <Typography variant="caption" color="text.secondary">{job.company}</Typography>}
                      <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'block', sm: 'none' } }}>
                        {fmtDateTime(job.received_at)}
                      </Typography>
                      {job.viewers?.length > 0 && (
                        <Box sx={{ mt: 0.5 }}>
                          <Typography variant="caption" sx={{ fontWeight: 600 }}>Viewed by</Typography>
                          {job.viewers.map(({ email, viewed_at }) => (
                            <Typography key={email} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              {email} · {fmtDateTime(viewed_at)}
                            </Typography>
                          ))}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', display: { xs: 'none', sm: 'table-cell' } }}>
                      {fmtDateTime(job.received_at)}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={statuses[job.status]} color={statusColors[job.status]} />
                      {(job.status === 'applied' || job.status === 'interviewed' || job.status === 'unfit') && job.status_actor && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {job.status_actor} · {fmtDateTime(job.status_at)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 0.5 }}>
                        <Button size="small" href={job.url} target="_blank" rel="noopener noreferrer"
                          onClick={() => changeStatus.mutate({ id: job.external_id, status: 'viewed' })}
                          onAuxClick={(event) => {
                            if (event.button === 1) changeStatus.mutate({ id: job.external_id, status: 'viewed' });
                          }}
                          endIcon={<ExternalLink size={14} />} sx={{ whiteSpace: 'nowrap' }}>
                          Open job
                        </Button>
                        {manual && (
                          <Button size="small" onClick={() => openForm({
                            id: job.external_id, url: job.url, title: job.title ?? '', company: job.company ?? '',
                          })}>Edit</Button>
                        )}
                        {job.status !== 'applied' && job.status !== 'interviewed' && (
                          <Button size="small" onClick={() => changeStatus.mutate({ id: job.external_id, status: 'applied' })}>
                            Mark as applied
                          </Button>
                        )}
                        {job.status !== 'interviewed' && job.status !== 'unfit' && (
                          <Button size="small" color="secondary" onClick={() => changeStatus.mutate({ id: job.external_id, status: 'interviewed' })}>
                            Mark interviewed
                          </Button>
                        )}
                        {job.status !== 'unfit' && job.status !== 'applied' && job.status !== 'interviewed' && (
                          <Button size="small" color="warning" onClick={() => changeStatus.mutate({ id: job.external_id, status: 'unfit' })}>
                            Mark as unfit
                          </Button>
                        )}
                        {job.status !== 'pending' && (
                          <Button size="small" color="inherit" onClick={() => changeStatus.mutate({ id: job.external_id, status: 'pending' })}>
                            Mark pending
                          </Button>
                        )}
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={rows.length}
            page={currentPage}
            rowsPerPage={pageSize}
            rowsPerPageOptions={[10, 25, 50]}
            onPageChange={(_, next) => setPage(next)}
            onRowsPerPageChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}
            sx={{ '& .MuiTablePagination-toolbar': { flexWrap: 'wrap', px: { xs: 1, sm: 2 } } }}
          />
        </>
      )}
    </Paper>
  );
}

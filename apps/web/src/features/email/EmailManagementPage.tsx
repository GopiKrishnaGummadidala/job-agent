import {
  Alert, Box, Button, Chip, MenuItem, Paper, Tab, Table, TableBody, TableCell, TableContainer, TextField,
  TableHead, TablePagination, TableRow, Tabs, Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link as RouterLink, Navigate, useParams } from 'react-router-dom';
import { ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { WorkspaceAccess, useWorkspace } from '../workspace/WorkspaceAccess';
import { api, fmtDateTime } from '../../lib/api';

const sections = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'indeed', label: 'Indeed' },
  { id: 'glassdoor', label: 'Glassdoor' },
];
const statuses = { pending: 'Pending', viewed: 'Viewed', applied: 'Applied', unfit: 'Unfit' } as const;
const statusColors = { pending: 'default', viewed: 'info', applied: 'success', unfit: 'warning' } as const;
type JobStatus = keyof typeof statuses;

export function EmailManagementPage() {
  const { provider } = useParams();
  const [workspace] = useWorkspace();
  const section = sections.find((item) => item.id === provider);
  if (!section) return <Navigate to="/email/linkedin" replace />;
  return (
    <>
      <PageHeader title="Email Management" subtitle="Import jobs from your unread Gmail alerts." />
      <WorkspaceAccess />
      <Paper variant="outlined" className="mb-4">
        <Tabs value={section.id} aria-label="Job alert sources" variant="scrollable" scrollButtons="auto">
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

function GmailJobs({ section, workspace }: { section: typeof sections[number]; workspace: string }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [statusFilter, setStatusFilter] = useState('all');
  const filter = '?' + new URLSearchParams({ provider: section.id, ...(workspace ? { workspace } : {}) });
  const jobKey = ['gmail-jobs', section.id, workspace];
  const qc = useQueryClient();
  const connection = useQuery({
    queryKey: ['gmail'],
    queryFn: () => api<{ configured: boolean; connection: { email: string } | null }>('/me/gmail'),
  });
  const jobs = useQuery({
    queryKey: jobKey,
    queryFn: () => api<{ external_id: string; title: string | null; received_at: string; url: string; status: JobStatus; status_at?: string; status_actor?: string }[]>('/me/gmail/jobs' + filter),
  });
  const run = useMutation({
    mutationFn: () => api<{ alertsSaved: number; jobsAdded: number; unreadRetained: number; markedRead: number }>('/me/gmail/jobs/import' + filter, {
      method: 'POST',
    }),
    onSettled: () => qc.invalidateQueries({ queryKey: jobKey }),
  });
  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: JobStatus }) =>
      api('/me/gmail/jobs/' + encodeURIComponent(id) + '/status', {
        method: 'PATCH', json: { provider: section.id, status, ...(workspace ? { workspace } : {}) },
      }),
    scope: { id: 'gmail-job-status-' + section.id },
    onSuccess: () => qc.invalidateQueries({ queryKey: jobKey }),
  });
  const rows = (jobs.data ?? []).filter((job) => statusFilter === 'all' || job.status === statusFilter);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Box className="flex flex-wrap items-center justify-between gap-2 p-4">
        <Typography variant="h6" component="h2">{section.label} jobs</Typography>
        {!workspace && (connection.data?.connection && connection.data.configured ? (
          <Button variant="outlined" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? 'Importing…' : 'Import unread alerts'}
          </Button>
        ) : connection.data && (
          <Button component={RouterLink} to="/settings">Gmail settings</Button>
        ))}
      </Box>
      <Box sx={{ px: 2, pb: 2 }}>
        <TextField select size="small" label="Filter by status" value={statusFilter} sx={{ minWidth: 155 }}
          onChange={(event) => { setStatusFilter(event.target.value); setPage(0); }}>
          <MenuItem value="all">All statuses</MenuItem>
          {Object.entries(statuses).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
        </TextField>
        <ErrorAlert error={connection.error ?? jobs.error ?? run.error ?? changeStatus.error} />
      </Box>
      {run.data && (
        <Alert sx={{ mx: 2, mb: 2 }} severity={run.data.unreadRetained ? 'warning' : 'success'}>
          Added {run.data.jobsAdded} jobs from {run.data.alertsSaved} alerts processed.
          {run.data.markedRead > 0 && ` Marked ${run.data.markedRead} alerts as read in Gmail.`}
          {run.data.unreadRetained > 0 && ` ${run.data.unreadRetained} alerts stayed unread for review.`}
        </Alert>
      )}
      {jobs.isLoading && <LoadingBlock rows={2} />}
      {jobs.data?.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>
          No {section.label} jobs imported yet.
        </Typography>
      )}
      {!!jobs.data?.length && rows.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>No jobs match this status.</Typography>
      )}
      {rows.length > 0 && (
        <>
          <TableContainer sx={{ borderTop: 1, borderColor: 'divider' }}>
            <Table size="small" aria-label={section.label + ' imported jobs'}>
              <TableHead sx={{ bgcolor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>Job title</TableCell>
                  <TableCell sx={{ fontWeight: 700, display: { xs: 'none', sm: 'table-cell' } }}>Alert received</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>Action</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((job) => (
                  <TableRow hover key={job.external_id} sx={{ '& td, & th': { py: 1 } }}>
                    <TableCell scope="row" component="th" sx={{ overflowWrap: 'anywhere' }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{job.title ?? section.label + ' job'}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'block', sm: 'none' } }}>
                        {fmtDateTime(job.received_at)}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', display: { xs: 'none', sm: 'table-cell' } }}>
                      {fmtDateTime(job.received_at)}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={statuses[job.status]} color={statusColors[job.status]} />
                      {(job.status === 'applied' || job.status === 'unfit') && job.status_actor && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {job.status_actor} · {fmtDateTime(job.status_at)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 0.5 }}>
                        <Button size="small" href={job.url} target="_blank" rel="noopener noreferrer"
                          onClick={() => {
                            if (job.status === 'pending') changeStatus.mutate({ id: job.external_id, status: 'viewed' });
                          }}
                          endIcon={<ExternalLink size={14} />} sx={{ whiteSpace: 'nowrap' }}>
                          Open job
                        </Button>
                        {job.status !== 'applied' && (
                          <Button size="small" onClick={() => changeStatus.mutate({ id: job.external_id, status: 'applied' })}>
                            Mark as applied
                          </Button>
                        )}
                        {job.status !== 'unfit' && job.status !== 'applied' && (
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

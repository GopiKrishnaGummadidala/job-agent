import { Alert, Box, Button, LinearProgress, List, ListItem, ListItemText, Paper, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { ErrorAlert, LoadingBlock, PageHeader, Stat } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';
import { BOARD_LABEL } from '../../lib/boards';

const EVENT_LABEL: Record<string, string> = {
  'source.added': 'Added a job board',
  'source.removed': 'Removed a job board',
  'resume.imported': 'Imported a resume',
  'resume.deleted': 'Deleted a resume',
  'profile.updated': 'Updated profile',
  'preferences.updated': 'Updated preferences',
  'settings.updated': 'Updated settings',
  'job.assessed': 'AI assessed a job',
  'draft.prepared': 'Prepared an application',
  'draft.edited': 'Edited an application',
  'draft.approved': 'Approved an application',
  'approval.invalidated': 'Approval withdrawn after an edit',
  'draft.rejected': 'Rejected an application',
  'draft.reopened': 'Reopened an application',
  'draft.assist_opened': 'Opened apply page with pre-filled form',
  'draft.handed_off': 'Opened apply page for manual submit',
  'application.submitted': 'Recorded a submitted application',
};
const dayLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function OverviewPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/me/dashboard') });
  if (isLoading) return <LoadingBlock rows={6} />;
  if (error || !data) return <ErrorAlert error={error} />;

  const funnel = [
    { label: 'Open jobs on your boards', value: data.jobs_found },
    { label: `Matched (score ≥ ${data.min_score})`, value: data.matched },
    { label: 'Awaiting your review', value: data.awaiting_review },
    { label: 'Approved, not yet submitted', value: data.approved },
    { label: 'Submitted', value: data.submitted },
  ];
  const max = Math.max(1, ...funnel.map((f) => f.value));
  const discovery: { day: string; count: number }[] = data.discovery ?? [];
  const discoveryPeak = Math.max(1, ...discovery.map(({ count }) => count));
  const setupNeeded = data.sources === 0 || data.resumes === 0;

  return (
    <>
      <PageHeader title="Overview" subtitle="Where your search stands today." />
      {setupNeeded && (
        <Alert
          severity="info"
          className="mb-4"
          action={
            <Button component={RouterLink} to={data.sources === 0 ? '/settings' : '/resumes'} color="inherit" size="small">
              Set up
            </Button>
          }
        >
          {data.sources === 0 ? 'Add a job board to start discovering jobs.' : 'Upload a resume so applications can be prepared.'}
        </Alert>
      )}
      <Box className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Matched jobs" value={data.matched} hint={`${data.jobs_found} open jobs`} />
        <Stat label="Awaiting approval" value={data.awaiting_review} />
        <Stat label="Submitted" value={data.submitted} hint={`${data.submitted_30d} in the last 30 days`} />
        <Stat label="AI spend this month" value={`$${Number(data.ai_spend_month).toFixed(2)}`} />
        <Stat label="First seen today" value={data.discovered_today ?? 0} />
        <Stat label="Shortlisted" value={data.shortlisted ?? 0} />
        <Stat label="Duplicates prevented" value={data.duplicates_30d ?? 0} hint="Board refreshes in the last 30 days" />
        <Stat label="Upcoming interviews" value={data.upcoming_interviews ?? 0} hint="Private confirmed calendar meetings" />
      </Box>
      <Box className="mt-4 grid gap-4 lg:grid-cols-2">
        <Paper className="p-4">
          <Typography variant="h6" component="h2">Jobs first seen</Typography>
          <Typography variant="body2" color="text.secondary">Last 7 days · Berlin time</Typography>
          <List dense>
            {discovery.map(({ day, count }) => (
              <ListItem key={day} disableGutters sx={{ display: 'grid', gridTemplateColumns: '58px 1fr 44px', gap: 1 }}>
                <Typography variant="body2">{dayLabel.format(new Date(day))}</Typography>
                <LinearProgress aria-hidden="true" variant="determinate" value={100 * count / discoveryPeak} />
                <Typography variant="body2" align="right">{count}</Typography>
              </ListItem>
            ))}
          </List>
        </Paper>
        <Paper className="p-4">
          <Typography variant="h6" component="h2">Board performance</Typography>
          <Typography variant="body2" color="text.secondary">Last 30 days</Typography>
          {!data.providers?.length && <Typography variant="body2" sx={{ mt: 1 }}>No board runs recorded yet.</Typography>}
          <List dense>
            {data.providers?.map((provider: { kind: string; runs: number; failures: number; inserted: number; last_success: string | null }) => (
              <ListItem key={provider.kind} disableGutters>
                <ListItemText primary={BOARD_LABEL[provider.kind] ?? provider.kind}
                  secondary={`${provider.runs} runs · ${provider.inserted} new jobs · ${provider.failures} failed${provider.last_success ? ` · Last success ${fmtDateTime(provider.last_success)}` : ''}`} />
              </ListItem>
            ))}
          </List>
        </Paper>
      </Box>
      <Box className="mt-4 grid gap-4 lg:grid-cols-2">
        <Paper className="p-4">
          <Typography variant="h6" component="h2" className="mb-3">
            Funnel
          </Typography>
          {funnel.map((f) => (
            <Box key={f.label} className="mb-3">
              <Box className="flex justify-between">
                <Typography variant="body2">{f.label}</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {f.value}
                </Typography>
              </Box>
              <LinearProgress variant="determinate" value={(100 * f.value) / max} sx={{ height: 8, borderRadius: 4, mt: 0.5 }} aria-label={f.label} />
            </Box>
          ))}
        </Paper>
        <Paper className="p-4">
          <Typography variant="h6" component="h2">
            Recent activity
          </Typography>
          {data.activity.length === 0 ? (
            <Typography color="text.secondary" className="mt-2">
              Nothing yet.
            </Typography>
          ) : (
            <List dense>
              {data.activity.map((a: any, i: number) => (
                <ListItem key={i} disableGutters>
                  <ListItemText primary={EVENT_LABEL[a.type] ?? a.type} secondary={fmtDateTime(a.at)} />
                </ListItem>
              ))}
            </List>
          )}
        </Paper>
      </Box>
      <Button component={RouterLink} to="/email/linkedin" sx={{ mt: 2 }}>Open Email Management</Button>
    </>
  );
}

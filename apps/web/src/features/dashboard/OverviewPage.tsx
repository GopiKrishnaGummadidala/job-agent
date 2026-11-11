import { Alert, Box, Button, LinearProgress, List, ListItem, ListItemText, Paper, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { ErrorAlert, LoadingBlock, PageHeader, Stat } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';

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
    </>
  );
}

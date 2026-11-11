import { Button, Link, Paper } from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { EmptyState, ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';

const columns: GridColDef[] = [
  { field: 'submitted_at', headerName: 'Submitted', width: 170, valueFormatter: (v) => fmtDateTime(v) },
  { field: 'title', headerName: 'Role', flex: 2, minWidth: 200, valueGetter: (_, r) => r.job.title },
  { field: 'company', headerName: 'Company', flex: 1, minWidth: 120, valueGetter: (_, r) => r.job.company },
  { field: 'resume', headerName: 'Resume sent', flex: 1, minWidth: 150, valueGetter: (_, r) => r.resume?.filename ?? '—' },
  {
    field: 'link',
    headerName: '',
    width: 120,
    sortable: false,
    renderCell: (p) => (
      <Link component={RouterLink} to={`/approvals/${p.row.draft_id}`}>
        View snapshot
      </Link>
    ),
  },
];

export function ApplicationsPage() {
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => api('/me/applications') });
  return (
    <>
      <PageHeader title="Applications" subtitle="Applications you approved and submitted, with the exact content that was sent." />
      {apps.isLoading ? (
        <LoadingBlock />
      ) : apps.error ? (
        <ErrorAlert error={apps.error} />
      ) : apps.data.length === 0 ? (
        <EmptyState title="No submitted applications yet" action={<Button component={RouterLink} to="/approvals" variant="contained">Go to approvals</Button>} />
      ) : (
        <Paper sx={{ height: 560 }}>
          <DataGrid rows={apps.data} columns={columns} density="compact" disableRowSelectionOnClick sx={{ border: 0 }} />
        </Paper>
      )}
    </>
  );
}

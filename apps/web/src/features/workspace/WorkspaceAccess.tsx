import { Alert, Box, Button, MenuItem, Paper, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorAlert } from '../../components/ui';
import { api } from '../../lib/api';

type Member = { id: string; email: string };
type Access = { shared: Member[]; delegates: Member[]; invites: { email: string }[]; resumeBuilder: boolean };

export function useWorkspace() {
  const [params, setParams] = useSearchParams();
  return [params.get('workspace') ?? '', (id: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (id) next.set('workspace', id);
    else next.delete('workspace');
    return next;
  })] as const;
}

export function WorkspaceAccess() {
  const [workspace, setWorkspace] = useWorkspace();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const qc = useQueryClient();
  const access = useQuery({ queryKey: ['workspace-access'], queryFn: () => api<Access>('/me/workspaces') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['workspace-access'] });
  const invite = useMutation({
    mutationFn: () => api<{ token: string }>('/me/workspaces/invites', { method: 'POST', json: { email: email.trim() } }),
    onSuccess: refresh,
  });
  const accept = useMutation({
    mutationFn: () => api<{ id: string }>('/me/workspaces/accept', { method: 'POST', json: { token: code.trim() } }),
    onSuccess: async ({ id }) => { await refresh(); setWorkspace(id); setCode(''); },
  });
  const revoke = useMutation({
    mutationFn: ({ id, email }: { id?: string; email: string }) =>
      api(id ? '/me/workspaces/delegates/' + id : '/me/workspaces/invites', {
        method: 'DELETE', json: id ? undefined : { email },
      }),
    onSuccess: refresh,
  });
  const available = access.data?.shared.some((item) => item.id === workspace);
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField select label="Workspace" size="small" value={workspace && available ? workspace : ''} sx={{ minWidth: 200 }}
          onChange={(event) => setWorkspace(event.target.value)}>
          <MenuItem value="">My workspace</MenuItem>
          {access.data?.shared.map((item) => <MenuItem key={item.id} value={item.id}>{item.email}</MenuItem>)}
        </TextField>
        {access.data?.resumeBuilder && (!workspace || available) && (
          <Button href={'/resume-builder/' + (workspace || 'personal') + '/'} target="_blank" rel="noopener noreferrer">
            Open Resume Builder
          </Button>
        )}
      </Box>
      {workspace && access.data && !available && <Alert severity="warning">This workspace is no longer shared with you.</Alert>}
      {!workspace && (
        <Box component="details" sx={{ mt: 2 }}>
          <Typography component="summary" sx={{ cursor: 'pointer' }}>Manage workspace access</Typography>
          <Box component="form" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }} sx={{ display: 'flex', gap: 1, my: 1, flexWrap: 'wrap' }}>
            <TextField label="Delegate email" type="email" size="small" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" disabled={invite.isPending}>Create invite code</Button>
          </Box>
          {invite.data && (
            <TextField label="Share this one-time code privately" size="small" fullWidth value={invite.data.token}
              slotProps={{ input: { readOnly: true } }} />
          )}
          {access.data?.invites.map((item) => (
            <Box key={item.email}>{item.email} · Invited <Button onClick={() => revoke.mutate(item)}>Cancel invite</Button></Box>
          ))}
          {access.data?.delegates.map((item) => (
            <Box key={item.id}>{item.email} <Button onClick={() => revoke.mutate(item)}>Revoke access</Button></Box>
          ))}
          <Box component="form" onSubmit={(e) => { e.preventDefault(); accept.mutate(); }} sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            <TextField label="Invite code" size="small" required value={code} onChange={(e) => setCode(e.target.value)} />
            <Button type="submit" disabled={accept.isPending}>Accept invitation</Button>
          </Box>
        </Box>
      )}
      <ErrorAlert error={access.error ?? invite.error ?? accept.error ?? revoke.error} />
    </Paper>
  );
}

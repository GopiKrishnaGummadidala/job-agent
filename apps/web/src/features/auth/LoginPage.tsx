import { Alert, Box, Button, Paper, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '../../lib/api';

export function LoginPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signupCode, setSignupCode] = useState('');
  const registration = useQuery({
    queryKey: ['registration'],
    queryFn: () => api<{ requiresCode: boolean }>('/auth/registration'),
    enabled: mode === 'register',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const me = await api(`/auth/${mode}`, { method: 'POST', json: { email, password, ...(mode === 'register' ? { signupCode } : {}) } });
      qc.setQueryData(['me'], me);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box className="grid min-h-screen place-items-center px-4">
      <Paper className="w-full max-w-sm p-6">
        <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
          Job Agent
        </Typography>
        <Typography color="text.secondary" variant="body2" className="mb-4 mt-1">
          Finds matching jobs and prepares applications. Nothing is sent without your approval.
        </Typography>
        <Tabs value={mode} onChange={(_, v) => setMode(v)} className="mb-4" variant="fullWidth">
          <Tab value="login" label="Sign in" />
          <Tab value="register" label="Create account" />
        </Tabs>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <TextField
            label="Password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            helperText={mode === 'register' ? 'At least 10 characters' : undefined}
          />
          {mode === 'register' && registration.data?.requiresCode && (
            <TextField label="Account invitation code" autoComplete="off" required value={signupCode}
              onChange={(e) => setSignupCode(e.target.value)} />
          )}
          {error && <Alert severity="error">{error}</Alert>}
          <Button type="submit" variant="contained" size="large" disabled={busy || (mode === 'register' && !registration.data)}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
      </Paper>
    </Box>
  );
}

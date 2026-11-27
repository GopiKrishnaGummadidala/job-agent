import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Paper, Switch, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorAlert, LoadingBlock, PageHeader, TagsInput } from '../../components/ui';
import { api } from '../../lib/api';

const germanySearchPreset = {
  titles: [
    'Senior Software Engineer', 'Senior Full Stack Engineer', 'Senior Frontend Engineer', 'Senior Backend Engineer',
    'Senior React Engineer', 'Senior Angular Engineer', 'Senior .NET Engineer', 'Senior Node.js Engineer',
    'Senior Python Engineer', 'Applied AI Engineer', 'AI Software Engineer', 'Freelance Software Engineer',
  ],
  keywords: [
    'React', 'Next.js', 'Angular', 'TypeScript', 'JavaScript', 'Node.js', 'NestJS', 'C#', '.NET', 'ASP.NET Core',
    'Python', 'FastAPI', 'Vue.js', 'PostgreSQL', 'SQL Server', 'Redis', 'Elasticsearch', 'RabbitMQ',
    'Azure', 'AWS', 'Docker', 'OpenAI', 'LLM integration', 'AI agents',
  ],
  locations: ['Hamburg', 'Germany'],
  remote_ok: true,
  salary_target_eur: 80_000,
  target_languages: ['English', 'German (B1 compatible)'],
  target_engagements: ['Permanent', 'Freelance', 'Contract'],
};

export function ProfilePage() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['profile'], queryFn: () => api('/me/profile') });
  const [profile, setProfile] = useState<any>(null);
  const [prefs, setPrefs] = useState<any>(null);
  const [newName, setNewName] = useState<string | null>(null);

  useEffect(() => {
    if (data.data) {
      setProfile(data.data.profile);
      setPrefs(data.data.preferences);
    }
  }, [data.data]);

  const done = (d: any) => {
    qc.setQueryData(['profile'], d);
    qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const saveProfile = useMutation({
    mutationFn: () => {
      const { user_id: _u, updated_at: _t, ...rest } = profile;
      return api('/me/profile', { method: 'PUT', json: rest });
    },
    onSuccess: done,
  });
  const savePrefs = useMutation({
    mutationFn: () => {
      const { id, user_id: _u, name: _n, ...rest } = prefs;
      return api('/me/preferences', { method: 'PUT', json: { ...rest, profile_id: id } });
    },
    onSuccess: done,
  });
  const activate = useMutation({
    mutationFn: (id: string) => api(`/me/search-profiles/${id}/active`, { method: 'PUT' }),
    onSuccess: done,
  });
  const create = useMutation({
    mutationFn: (name: string) => api('/me/search-profiles', { method: 'POST', json: { name } }),
    onSuccess: (result) => { setNewName(null); done(result); },
  });

  if (data.isLoading || !profile || !prefs) return <LoadingBlock rows={8} />;
  if (data.error) return <ErrorAlert error={data.error} />;
  const prefsDirty = JSON.stringify(prefs) !== JSON.stringify(data.data.preferences);
  const switching = create.isPending || activate.isPending || savePrefs.isPending;

  const p = (k: string) => ({
    value: profile[k] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setProfile({ ...profile, [k]: e.target.value }),
  });

  return (
    <>
      <PageHeader title="Profile & Preferences" subtitle="Only facts entered here (and in your resumes) are used in cover letters and answers." />
      <Box className="grid gap-4 lg:grid-cols-2">
        <Paper className="p-4">
          <Typography variant="h6" component="h2" className="mb-3">Candidate profile</Typography>
          <Box className="grid gap-3 sm:grid-cols-2">
            <TextField label="Full name" {...p('full_name')} />
            <TextField label="Contact email" type="email" {...p('email')} />
            <TextField label="Phone" {...p('phone')} />
            <TextField label="LinkedIn URL" {...p('linkedin_url')} />
            <TextField label="Headline" placeholder="e.g. Senior .NET engineer" {...p('headline')} className="sm:col-span-2" />
            <TextField label="Location" {...p('location')} />
            <TextField
              label="Years of experience"
              type="number"
              value={profile.years_experience ?? ''}
              onChange={(e) => setProfile({ ...profile, years_experience: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <TextField label="Work authorization" placeholder="e.g. EU Blue Card, Germany" {...p('work_authorization')} className="sm:col-span-2" />
          </Box>
          <Box className="mt-3 flex flex-col gap-3">
            <TagsInput label="Skills" value={profile.skills} onChange={(v) => setProfile({ ...profile, skills: v })} />
            <TagsInput label="Languages" value={profile.languages} onChange={(v) => setProfile({ ...profile, languages: v })} />
            <TextField label="Summary" multiline minRows={4} {...p('summary')} />
          </Box>
          <ErrorAlert error={saveProfile.error} />
          {saveProfile.isSuccess && <Alert severity="success" className="mt-3">Saved. Matches were recalculated.</Alert>}
          <Button variant="contained" className="mt-3" onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}>Save profile</Button>
        </Paper>

        <Paper className="p-4">
          <Typography variant="h6" component="h2" className="mb-3">Job preferences</Typography>
          <Box className="flex flex-col gap-3">
            <Box className="flex flex-wrap items-start gap-2">
              <TextField select size="small" label="Active search profile" value={prefs.id}
                disabled={switching || prefsDirty} onChange={(event) => activate.mutate(event.target.value)} sx={{ minWidth: 185 }}>
                {(data.data.search_profiles ?? [{ id: prefs.id, name: prefs.name }]).map((item: { id: string; name: string }) => (
                  <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>
                ))}
              </TextField>
              <Button disabled={switching || prefsDirty} onClick={() => { create.reset(); setNewName(''); }}>New search profile</Button>
              {prefsDirty && <Button onClick={() => setPrefs(data.data.preferences)} disabled={switching}>Discard preference edits</Button>}
            </Box>
            <ErrorAlert error={activate.error} />
            <Box>
              <Button variant="outlined" onClick={() => setPrefs({ ...prefs, ...germanySearchPreset })}>Load Germany software search</Button>
              <Typography variant="caption" color="text.secondary" component="p">
                Fills the form for review. Save preferences to apply the preset.
              </Typography>
            </Box>
            <TagsInput label="Target roles" value={prefs.titles} onChange={(v) => setPrefs({ ...prefs, titles: v })} helperText="e.g. Backend Engineer, .NET Developer" />
            <TagsInput label="Extra keywords" value={prefs.keywords} onChange={(v) => setPrefs({ ...prefs, keywords: v })} helperText="Technologies to look for beyond your skills" />
            <TagsInput label="Preferred locations" value={prefs.locations} onChange={(v) => setPrefs({ ...prefs, locations: v })} helperText="City or country names, e.g. Hamburg or Germany. A country includes all its cities and Europe-wide remote jobs." />
            <FormControlLabel control={<Switch checked={prefs.remote_ok} onChange={(e) => setPrefs({ ...prefs, remote_ok: e.target.checked })} />} label="Remote roles are fine (only those open to your preferred countries)" />
            <TagsInput label="Excluded companies" value={prefs.excluded_companies} onChange={(v) => setPrefs({ ...prefs, excluded_companies: v })} />
            <TagsInput label="Excluded title keywords" value={prefs.excluded_keywords} onChange={(v) => setPrefs({ ...prefs, excluded_keywords: v })} helperText="e.g. Intern, Principal, Sales" />
            <TagsInput label="Preferred job languages" value={prefs.target_languages ?? []} onChange={(v) => setPrefs({ ...prefs, target_languages: v })} />
            <TagsInput label="Preferred engagement types" value={prefs.target_engagements ?? []} onChange={(v) => setPrefs({ ...prefs, target_engagements: v })} />
            <Box className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Negotiable annual salary target (€)"
                type="number"
                value={prefs.salary_target_eur ?? ''}
                onChange={(e) => setPrefs({ ...prefs, salary_target_eur: e.target.value === '' ? null : Number(e.target.value) })}
                helperText="Used for assessment when salary is disclosed"
              />
              <TextField
                label="Salary floor (yearly)"
                type="number"
                value={prefs.salary_floor ?? ''}
                onChange={(e) => setPrefs({ ...prefs, salary_floor: e.target.value === '' ? null : Number(e.target.value) })}
                helperText="Stored for later; most boards don't publish salaries"
              />
              <TextField
                label="Default minimum match"
                type="number"
                value={prefs.min_score}
                onChange={(e) => setPrefs({ ...prefs, min_score: Math.max(0, Math.min(100, Number(e.target.value))) })}
              />
            </Box>
          </Box>
          <ErrorAlert error={savePrefs.error} />
          {savePrefs.isSuccess && <Alert severity="success" className="mt-3">Saved. Matches were recalculated.</Alert>}
          <Button variant="contained" className="mt-3" onClick={() => savePrefs.mutate()} disabled={switching}>Save preferences</Button>
        </Paper>
      </Box>
      {newName !== null && (
        <Dialog open fullWidth maxWidth="xs" onClose={() => { if (!create.isPending) setNewName(null); }}>
          <Box component="form" onSubmit={(event) => { event.preventDefault(); create.mutate(newName.trim()); }}>
            <DialogTitle>New search profile</DialogTitle>
            <DialogContent>
              <TextField autoFocus required fullWidth margin="dense" label="Profile name" value={newName}
                helperText="Starts from your saved preferences."
                onChange={(event) => setNewName(event.target.value)} slotProps={{ htmlInput: { maxLength: 80 } }} />
              <ErrorAlert error={create.error} />
            </DialogContent>
            <DialogActions>
              <Button disabled={create.isPending} onClick={() => setNewName(null)}>Cancel</Button>
              <Button type="submit" variant="contained" disabled={create.isPending || !newName.trim()}>Create profile</Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
    </>
  );
}

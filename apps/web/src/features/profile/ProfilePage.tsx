import { Alert, Box, Button, FormControlLabel, Paper, Switch, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ErrorAlert, LoadingBlock, PageHeader, TagsInput } from '../../components/ui';
import { api } from '../../lib/api';

export function ProfilePage() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['profile'], queryFn: () => api('/me/profile') });
  const [profile, setProfile] = useState<any>(null);
  const [prefs, setPrefs] = useState<any>(null);

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
      const { id: _i, user_id: _u, name: _n, ...rest } = prefs;
      return api('/me/preferences', { method: 'PUT', json: rest });
    },
    onSuccess: done,
  });

  if (data.isLoading || !profile || !prefs) return <LoadingBlock rows={8} />;
  if (data.error) return <ErrorAlert error={data.error} />;

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
            <TagsInput label="Target roles" value={prefs.titles} onChange={(v) => setPrefs({ ...prefs, titles: v })} helperText="e.g. Backend Engineer, .NET Developer" />
            <TagsInput label="Extra keywords" value={prefs.keywords} onChange={(v) => setPrefs({ ...prefs, keywords: v })} helperText="Technologies to look for beyond your skills" />
            <TagsInput label="Preferred locations" value={prefs.locations} onChange={(v) => setPrefs({ ...prefs, locations: v })} helperText="City or country names, e.g. Hamburg, Germany" />
            <FormControlLabel control={<Switch checked={prefs.remote_ok} onChange={(e) => setPrefs({ ...prefs, remote_ok: e.target.checked })} />} label="Remote roles are fine" />
            <TagsInput label="Excluded companies" value={prefs.excluded_companies} onChange={(v) => setPrefs({ ...prefs, excluded_companies: v })} />
            <TagsInput label="Excluded title keywords" value={prefs.excluded_keywords} onChange={(v) => setPrefs({ ...prefs, excluded_keywords: v })} helperText="e.g. Intern, Principal, Sales" />
            <Box className="grid gap-3 sm:grid-cols-2">
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
          <Button variant="contained" className="mt-3" onClick={() => savePrefs.mutate()} disabled={savePrefs.isPending}>Save preferences</Button>
        </Paper>
      </Box>
    </>
  );
}

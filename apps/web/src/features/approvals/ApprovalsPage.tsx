import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { EmptyState, ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';
import { statusColor, statusLabel } from '../../styles/theme';

export function ApprovalsPage() {
  const { id } = useParams();
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('lg'));
  const drafts = useQuery({ queryKey: ['drafts'], queryFn: () => api('/me/application-drafts') });

  const list = drafts.isLoading ? (
    <LoadingBlock />
  ) : drafts.error ? (
    <ErrorAlert error={drafts.error} />
  ) : drafts.data.length === 0 ? (
    <EmptyState title="Nothing to review" action={<Button component={RouterLink} to="/jobs" variant="contained">Explore jobs</Button>}>
      Prepare an application from the Job Explorer. It appears here for your review and approval.
    </EmptyState>
  ) : (
    <Paper>
      <List disablePadding>
        {drafts.data.map((d: any) => (
          <ListItemButton key={d.id} component={RouterLink} to={`/approvals/${d.id}`} selected={d.id === id} divider>
            <ListItemText
              primary={d.title}
              secondary={`${d.company} · match ${d.score ?? '—'}${d.closed_at ? ' · posting closed' : ''}`}
              slotProps={{ primary: { noWrap: true } }}
            />
            <Chip size="small" label={statusLabel[d.status]} color={statusColor[d.status]} variant="outlined" className="ml-2" />
          </ListItemButton>
        ))}
      </List>
    </Paper>
  );

  return (
    <>
      <PageHeader title="Approval Queue" subtitle="Review exactly what will be sent. Every application needs your explicit approval." />
      {wide ? (
        <Box className="grid grid-cols-[360px_1fr] gap-4">
          <Box>{list}</Box>
          <Box>{id ? <DraftReview id={id} /> : <EmptyState title="Select an application to review" />}</Box>
        </Box>
      ) : id ? (
        <>
          <Button component={RouterLink} to="/approvals" startIcon={<ArrowLeft size={16} />} className="mb-3">All applications</Button>
          <DraftReview id={id} />
        </>
      ) : (
        list
      )}
    </>
  );
}

interface Answer {
  question: string;
  answer: string;
}

function DraftReview({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const draft = useQuery({ queryKey: ['draft', id], queryFn: () => api(`/me/application-drafts/${id}`) });
  const resumes = useQuery({ queryKey: ['resumes'], queryFn: () => api('/me/resumes') });
  const [letter, setLetter] = useState('');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [resumeId, setResumeId] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [assistReport, setAssistReport] = useState<any>(null);

  const d = draft.data;
  useEffect(() => {
    if (!d) return;
    setLetter(d.cover_letter);
    setAnswers(d.answers ?? []);
    setResumeId(d.resume_id ?? '');
    setNotes(d.notes ?? '');
  }, [d?.id, d?.content_hash, d?.notes]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSaved = (next: any) => {
    qc.setQueryData(['draft', id], next);
    qc.invalidateQueries({ queryKey: ['drafts'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api(`/me/application-drafts/${id}`, {
        method: 'PATCH',
        json: { cover_letter: letter, answers: answers.filter((a) => a.question.trim()), resume_id: resumeId || null, notes },
      }),
    onSuccess: onSaved,
  });
  const act = useMutation({
    mutationFn: ({ path, json, headers }: { path: string; json?: unknown; headers?: Record<string, string> }) =>
      api(`/me/application-drafts/${id}/${path}`, { method: 'POST', json, headers }),
    onSuccess: (res, vars) => {
      if (vars.path === 'assist') {
        setAssistReport(res);
        qc.invalidateQueries({ queryKey: ['draft', id] });
      } else if (vars.path === 'submitted') {
        qc.invalidateQueries();
        navigate('/applications');
      } else onSaved(res);
    },
  });

  if (draft.isLoading) return <LoadingBlock rows={8} />;
  if (draft.error) return <ErrorAlert error={draft.error} />;

  const dirty =
    letter !== d.cover_letter ||
    JSON.stringify(answers.filter((a) => a.question.trim())) !== JSON.stringify(d.answers) ||
    (resumeId || null) !== d.resume_id ||
    notes !== (d.notes ?? '');
  const editable = !['submitted', 'rejected'].includes(d.status);
  const err = save.error ?? act.error;

  return (
    <Paper className="p-4 sm:p-6">
      <Box className="flex flex-wrap items-start justify-between gap-3">
        <Box className="min-w-0">
          <Typography variant="h6" component="h2">{d.title}</Typography>
          <Typography color="text.secondary">{d.company} · {d.location || 'Location not stated'}</Typography>
          <Typography variant="body2" className="mt-1">
            Destination: <a href={d.apply_url} target="_blank" rel="noreferrer" className="break-all underline">{d.apply_url}</a>
          </Typography>
        </Box>
        <Chip label={statusLabel[d.status]} color={statusColor[d.status]} />
      </Box>

      {d.closed_at && <Alert severity="warning" className="mt-3">This posting closed on {fmtDateTime(d.closed_at)}.</Alert>}
      {d.status === 'awaiting_review' && d.approved_at === null && d.approval_id === null && (
        <Alert severity="info" className="mt-3">Review the resume, cover letter and answers below, then approve.</Alert>
      )}
      <Box className="mt-3"><ErrorAlert error={err} /></Box>

      <TextField
        select
        label="Resume to send (read-only file)"
        className="mt-2"
        value={resumeId}
        onChange={(e) => setResumeId(e.target.value)}
        disabled={!editable}
        helperText={d.resume_sha256 ? `Selected version SHA-256 ${d.resume_sha256.slice(0, 12)}…` : 'Upload a resume in the Resume Library first.'}
      >
        <MenuItem value="">None</MenuItem>
        {(resumes.data ?? []).map((r: any) => (
          <MenuItem key={r.id} value={r.id}>{r.filename} · {fmtDateTime(r.uploaded_at)}</MenuItem>
        ))}
      </TextField>

      <Box className="mt-4 flex items-center justify-between">
        <Typography variant="subtitle2">Cover letter</Typography>
        <Typography variant="caption" color="text.secondary">Generated by {d.cover_letter_source}. Check every claim before approving.</Typography>
      </Box>
      <TextField multiline minRows={10} maxRows={24} value={letter} onChange={(e) => setLetter(e.target.value)} disabled={!editable} className="mt-1" slotProps={{ htmlInput: { 'aria-label': 'Cover letter' } }} />

      <Box className="mt-4 flex items-center justify-between">
        <Typography variant="subtitle2">Screening answers</Typography>
        {editable && (
          <Button size="small" startIcon={<Plus size={14} />} onClick={() => setAnswers([...answers, { question: '', answer: '' }])}>Add</Button>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Copy questions from the employer's form. Browser assist fills fields whose label matches the question.
      </Typography>
      {answers.map((a, i) => (
        <Box key={i} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <TextField label="Question" value={a.question} disabled={!editable} onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} />
          <TextField label="Answer" value={a.answer} disabled={!editable} onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))} />
          {editable && <IconButton aria-label="Remove answer" onClick={() => setAnswers(answers.filter((_, j) => j !== i))}><Trash2 size={16} /></IconButton>}
        </Box>
      ))}

      <TextField label="Private notes (not sent, no re-approval needed)" multiline minRows={2} className="mt-4" value={notes} onChange={(e) => setNotes(e.target.value)} />

      <Box className="mt-5 flex flex-wrap gap-2">
        {dirty && (
          <Button variant="contained" onClick={() => save.mutate()} disabled={save.isPending}>
            {d.approval_valid ? 'Save (requires re-approval)' : 'Save changes'}
          </Button>
        )}
        {!dirty && ['awaiting_review', 'manual_action_required'].includes(d.status) && (
          <Button variant="contained" color="success" onClick={() => act.mutate({ path: 'approve', json: { content_hash: d.content_hash } })} disabled={act.isPending || !!d.closed_at}>
            Approve this application
          </Button>
        )}
        {!dirty && d.approval_valid && d.status !== 'submitted' && (
          <>
            <Button variant="contained" onClick={() => act.mutate({ path: 'assist' })} disabled={act.isPending}>
              {act.isPending && act.variables?.path === 'assist' ? 'Opening browser…' : 'Open & pre-fill apply form'}
            </Button>
            <Button component="a" href={d.apply_url} target="_blank" rel="noreferrer" endIcon={<ExternalLink size={14} />} onClick={() => act.mutate({ path: 'handoff' })}>
              Apply manually
            </Button>
            <Button startIcon={<Copy size={14} />} onClick={() => navigator.clipboard.writeText(d.cover_letter)}>Copy letter</Button>
            <Button color="success" variant="outlined" onClick={() => setConfirmOpen(true)}>I submitted it</Button>
          </>
        )}
        {editable && (
          <Button color="inherit" onClick={() => act.mutate({ path: 'reject' })} disabled={act.isPending}>Reject</Button>
        )}
        {d.status === 'rejected' && <Button onClick={() => act.mutate({ path: 'reopen' })}>Reopen</Button>}
      </Box>
      {d.approval_valid && (
        <Typography variant="caption" color="text.secondary" component="p" className="mt-2">
          Approved {fmtDateTime(d.approved_at)}. Changing the resume, letter or answers withdraws this approval.
        </Typography>
      )}

      {assistReport && (
        <Alert severity="info" className="mt-4" onClose={() => setAssistReport(null)}>
          A browser window opened with the form pre-filled ({assistReport.filled.join(', ') || 'no fields recognised'}).
          {assistReport.notFound.length > 0 && ` Not found: ${assistReport.notFound.join(', ')}.`} Review it, complete any remaining fields and
          submit there yourself, then click “I submitted it”.
        </Alert>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Record this application as submitted?</DialogTitle>
        <DialogContent>
          <Typography>Only confirm after you submitted it on the employer's site. The approved snapshot is stored with your history.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirmOpen(false);
              act.mutate({ path: 'submitted', headers: { 'idempotency-key': `${id}-${d.content_hash.slice(0, 16)}` } });
            }}
          >
            Yes, I submitted it
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

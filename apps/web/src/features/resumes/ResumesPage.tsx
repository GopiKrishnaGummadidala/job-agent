import { Alert, Box, Button, Card, CardActions, CardContent, Chip, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { EmptyState, ErrorAlert, LoadingBlock, PageHeader } from '../../components/ui';
import { api, fmtDateTime } from '../../lib/api';

export function ResumesPage() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const resumes = useQuery({ queryKey: ['resumes'], queryFn: () => api('/me/resumes') });
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api('/me/profile') });
  const builderUrl: string = profile.data?.settings.resume_builder_url ?? '';

  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api('/me/resumes', { method: 'POST', body: fd });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['resumes'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/me/resumes/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resumes'] }),
  });

  return (
    <>
      <PageHeader
        title="Resume Library"
        subtitle="Read-only copies of your resumes. Job Agent recommends one per job but never edits them."
        actions={
          <>
            {builderUrl && (
              <Button href={builderUrl} target="_blank" rel="noreferrer" endIcon={<ExternalLink size={14} />}>
                Open Resume Builder
              </Button>
            )}
            <Button variant="contained" startIcon={<Upload size={16} />} onClick={() => input.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? 'Uploading…' : 'Upload PDF or DOCX'}
            </Button>
          </>
        }
      />
      <input
        ref={input}
        type="file"
        hidden
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = '';
        }}
      />
      <ErrorAlert error={upload.error ?? remove.error} />
      {upload.data?.duplicate && <Alert severity="info" className="mb-3">That exact file is already in your library.</Alert>}
      {upload.data && upload.data.has_text === false && (
        <Alert severity="warning" className="mb-3">No text could be read from this file (it may be a scanned image), so it cannot be matched against jobs.</Alert>
      )}
      {resumes.isLoading ? (
        <LoadingBlock />
      ) : resumes.error ? (
        <ErrorAlert error={resumes.error} />
      ) : resumes.data.length === 0 ? (
        <EmptyState title="No resumes yet">
          Upload the resumes you already have. After you edit one in your resume builder, upload it again: it is stored as a new version and older applications keep the exact file they used.
        </EmptyState>
      ) : (
        <Box className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {resumes.data.map((r: any) => (
            <Card key={r.id} className="flex flex-col">
              <CardContent className="flex-1">
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap title={r.filename}>{r.filename}</Typography>
                <Typography variant="caption" color="text.secondary" component="p">
                  {fmtDateTime(r.uploaded_at)} · {(r.size_bytes / 1024).toFixed(0)} KB · SHA-256 {r.sha256.slice(0, 10)}…
                </Typography>
                <Box className="mt-1 flex gap-1">
                  {r.used_by > 0 && <Chip size="small" label={`Used in ${r.used_by} application${r.used_by > 1 ? 's' : ''}`} />}
                  {!r.has_text && <Chip size="small" color="warning" label="No readable text" />}
                </Box>
                <Typography variant="body2" color="text.secondary" className="prewrap mt-2 line-clamp-6">{r.preview}</Typography>
              </CardContent>
              <CardActions>
                <Button size="small" startIcon={<Download size={14} />} href={`/api/me/resumes/${r.id}/file`}>Download</Button>
                <Button size="small" color="inherit" startIcon={<Trash2 size={14} />} disabled={r.used_by > 0 || remove.isPending} onClick={() => remove.mutate(r.id)}>
                  Delete
                </Button>
              </CardActions>
            </Card>
          ))}
        </Box>
      )}
    </>
  );
}

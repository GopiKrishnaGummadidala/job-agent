import { Alert, Autocomplete, Box, Chip, Paper, Skeleton, TextField, Typography } from '@mui/material';
import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Box className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <Box className="min-w-0">
        <Typography variant="h4" component="h1">
          {title}
        </Typography>
        {subtitle && (
          <Typography color="text.secondary" className="mt-1">
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions && <Box className="flex flex-wrap gap-2">{actions}</Box>}
    </Box>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Paper className="p-8 text-center">
      <Typography variant="h6">{title}</Typography>
      {children && (
        <Typography color="text.secondary" className="mx-auto mt-2 max-w-lg">
          {children}
        </Typography>
      )}
      {action && <Box className="mt-4">{action}</Box>}
    </Paper>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <Box aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={44} />
      ))}
    </Box>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert severity="error" className="mb-4">
      {error instanceof Error ? error.message : String(error)}
    </Alert>
  );
}

/** Free-text tag input for lists such as skills, titles and locations. */
export function TagsInput({
  label,
  value,
  onChange,
  helperText,
  options = [],
  disabled,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  helperText?: string;
  /** Suggestions; free text is still allowed. */
  options?: string[];
  disabled?: boolean;
}) {
  return (
    <Autocomplete
      multiple
      freeSolo
      disabled={disabled}
      options={options.filter((o) => !value.some((v) => v.toLowerCase() === o.toLowerCase()))}
      value={value}
      onChange={(_, v) => onChange([...new Set(v.map((s) => s.trim()).filter(Boolean))])}
      renderValue={(vals, getItemProps) =>
        vals.map((opt, index) => {
          const { key, ...rest } = getItemProps({ index });
          return <Chip key={key} size="small" label={opt} {...rest} />;
        })
      }
      renderInput={(params) => (
        <TextField {...params} label={label} helperText={helperText ?? 'Type and press Enter to add'} />
      )}
    />
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Paper className="p-4">
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h4" component="p" className="mt-1">
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
    </Paper>
  );
}

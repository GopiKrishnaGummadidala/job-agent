import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'class' },
  colorSchemes: {
    light: { palette: { primary: { main: '#2952cc' }, background: { default: '#f6f7fb' } } },
    dark: { palette: { primary: { main: '#8aa6ff' }, background: { default: '#0f1218', paper: '#161a22' } } },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    h4: { fontWeight: 700, fontSize: '1.6rem' },
    h6: { fontWeight: 600 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } } },
    MuiCard: { defaultProps: { variant: 'outlined' } },
    MuiPaper: { defaultProps: { variant: 'outlined' } },
    MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
  },
});

export const statusColor: Record<string, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
  awaiting_review: 'warning',
  approved: 'success',
  handed_off: 'info',
  submitted: 'primary',
  rejected: 'default',
  manual_action_required: 'error',
};

export const statusLabel: Record<string, string> = {
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  handed_off: 'Opened for submit',
  submitted: 'Submitted',
  rejected: 'Rejected',
  manual_action_required: 'Needs manual action',
};

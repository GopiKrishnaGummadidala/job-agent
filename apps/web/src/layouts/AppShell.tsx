import {
  AppBar,
  Badge,
  Box,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Tooltip,
  Typography,
  useColorScheme,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BriefcaseBusiness,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Send,
  Settings,
  Sun,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../lib/api';

const WIDTH = 232;

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/jobs', label: 'Job Explorer', icon: BriefcaseBusiness },
  { to: '/approvals', label: 'Approval Queue', icon: ClipboardCheck, badge: true },
  { to: '/applications', label: 'Applications', icon: Send },
  { to: '/resumes', label: 'Resume Library', icon: FileText },
  { to: '/profile', label: 'Profile & Preferences', icon: UserRound },
  { to: '/settings', label: 'Sources & Settings', icon: Settings },
];

export function AppShell({ email }: { email: string }) {
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up('md'));
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const { mode, systemMode, setMode } = useColorScheme();
  const dark = (mode === 'system' ? systemMode : mode) === 'dark';
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/me/dashboard') });

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    qc.setQueryData(['me'], null);
  };

  const nav = (
    <Box className="flex h-full flex-col">
      <Toolbar>
        <Typography variant="h6" component="div">
          Job Agent
        </Typography>
      </Toolbar>
      <List component="nav" aria-label="Main" className="flex-1 px-2">
        {NAV.map(({ to, label, icon: Icon, badge }) => {
          const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
          return (
            <ListItemButton
              key={to}
              component={NavLink}
              to={to}
              selected={active}
              onClick={() => setOpen(false)}
              sx={{ borderRadius: 2, mb: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>
                <Badge color="warning" badgeContent={badge ? dash.data?.awaiting_review : 0} max={99}>
                  <Icon size={20} aria-hidden />
                </Badge>
              </ListItemIcon>
              <ListItemText primary={label} slotProps={{ primary: { variant: 'body2', sx: { fontWeight: active ? 600 : 400 } } }} />
            </ListItemButton>
          );
        })}
      </List>
      <Box className="px-4 pb-4">
        <Typography variant="caption" color="text.secondary" noWrap component="div">
          {email}
        </Typography>
      </Box>
    </Box>
  );

  return (
    <Box className="flex min-h-screen">
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: 'divider', width: { md: `calc(100% - ${WIDTH}px)` }, ml: { md: `${WIDTH}px` } }}
      >
        <Toolbar className="gap-2">
          {!desktop && (
            <IconButton edge="start" aria-label="Open navigation" onClick={() => setOpen(true)}>
              <Menu size={20} />
            </IconButton>
          )}
          <Typography variant="subtitle1" className="flex-1" noWrap>
            {NAV.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)))?.label}
          </Typography>
          <Tooltip title={dark ? 'Light theme' : 'Dark theme'}>
            <IconButton aria-label="Toggle theme" onClick={() => setMode(dark ? 'light' : 'dark')}>
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Sign out">
            <IconButton aria-label="Sign out" onClick={logout}>
              <LogOut size={18} />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Box component="nav" sx={{ width: { md: WIDTH }, flexShrink: 0 }}>
        <Drawer
          variant={desktop ? 'permanent' : 'temporary'}
          open={desktop || open}
          onClose={() => setOpen(false)}
          ModalProps={{ keepMounted: true }}
          slotProps={{ paper: { sx: { width: WIDTH, boxSizing: 'border-box' } } }}
        >
          {nav}
        </Drawer>
      </Box>
      <Box component="main" className="min-w-0 flex-1 px-4 pb-10 sm:px-6" sx={{ pt: 10 }}>
        <Box className="mx-auto max-w-7xl">
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}

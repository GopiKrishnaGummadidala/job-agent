import { Box, CircularProgress } from '@mui/material';
import { EmailManagementPage } from '../features/email/EmailManagementPage';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ApplicationsPage } from '../features/applications/ApplicationsPage';
import { ApprovalsPage } from '../features/approvals/ApprovalsPage';
import { LoginPage } from '../features/auth/LoginPage';
import { OverviewPage } from '../features/dashboard/OverviewPage';
import { JobsPage } from '../features/jobs/JobsPage';
import { InterviewsPage } from '../features/interviews/InterviewsPage';
import { ProfilePage } from '../features/profile/ProfilePage';
import { ResumesPage } from '../features/resumes/ResumesPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { AppShell } from '../layouts/AppShell';
import { useMe } from '../lib/auth';

export function App() {
  const me = useMe();
  if (me.isLoading) {
    return (
      <Box className="grid h-screen place-items-center">
        <CircularProgress aria-label="Loading" />
      </Box>
    );
  }
  if (!me.data) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<AppShell email={me.data.email} />}>
        <Route index element={<OverviewPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="email/:provider?" element={<EmailManagementPage />} />
        <Route path="interviews" element={<InterviewsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="approvals/:id" element={<ApprovalsPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="resumes" element={<ResumesPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

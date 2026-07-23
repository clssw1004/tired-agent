import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoginPage } from './pages/LoginPage';
import { ServerListPage } from './pages/ServerListPage';
import { ServerEditPage } from './pages/ServerEditPage';
import { SessionListPage } from './pages/SessionListPage';
import { SessionCreatePage } from './pages/SessionCreatePage';
import { TerminalPage } from './pages/TerminalPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { useAuth } from './store/AuthContext';
import { NavProvider, useNav } from './store/NavContext';
import { ToastProvider } from './components/Toast';

/**
 * Route guard — redirects to login when not authenticated.
 * Shows a loading state while the boot effect resolves.
 */
function ProtectedRoute({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.status === 'uninitialized') {
    return <div className="page-loading">Loading…</div>;
  }
  if (auth.status !== 'logged-in') {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/**
 * Top nav, only visible when the user is logged in. LoginPage handles
 * its own chrome. The `is-hidden` class is applied when the mobile toggle
 * is collapsed (controlled by NavContext).
 */
function AppNav() {
  const auth = useAuth();
  const { navHidden } = useNav();
  if (auth.status !== 'logged-in') return null;
  return (
    <nav className={'app-nav' + (navHidden ? ' is-hidden' : '')}>
      <NavLink to="/servers" className={({ isActive }) => (isActive ? 'app-nav-link active' : 'app-nav-link')}>
        Agents
      </NavLink>
      <NavLink to="/onboarding" className={({ isActive }) => (isActive ? 'app-nav-link active' : 'app-nav-link')}>
        Onboarding
      </NavLink>
      <div className="app-nav-spacer" />
      {auth.managerBaseUrl && (
        <div className="app-nav-meta">{auth.managerBaseUrl}</div>
      )}
      <button className="btn-ghost" onClick={auth.logout}>Logout</button>
    </nav>
  );
}

export default function App() {
  return (
    // app-shell extends #root's flex column so that pages can use `flex: 1`
    // to fill the viewport. Without it, nested `height: 100%` between the
    // router and the page collapses to 0 and xterm never gets a height.
    <ToastProvider>
    <NavProvider>
    <div className="app-shell">
      <AppNav />
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/servers" element={<ProtectedRoute><ServerListPage /></ProtectedRoute>} />
        <Route path="/servers/new" element={<ProtectedRoute><ServerEditPage mode="create" /></ProtectedRoute>} />
        <Route path="/servers/:id/edit" element={<ProtectedRoute><ServerEditPage mode="edit" /></ProtectedRoute>} />
        <Route path="/servers/:id" element={<ProtectedRoute><SessionListPage /></ProtectedRoute>} />
        <Route path="/servers/:id/sessions/new" element={<ProtectedRoute><SessionCreatePage /></ProtectedRoute>} />
        <Route path="/servers/:id/sessions/:sid" element={<ProtectedRoute><TerminalPage /></ProtectedRoute>} />
        <Route path="/onboarding" element={<ProtectedRoute><OnboardingPage /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
    </NavProvider>
    </ToastProvider>
  );
}

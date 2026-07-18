import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { ServerListPage } from './pages/ServerListPage';
import { ServerEditPage } from './pages/ServerEditPage';
import { SessionListPage } from './pages/SessionListPage';
import { SessionCreatePage } from './pages/SessionCreatePage';
import { TerminalPage } from './pages/TerminalPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { useAuth } from './store/AuthContext';
import { ToastProvider } from './components/Toast';

/**
 * Top nav, only visible when the user is logged in. LoginPage handles
 * its own chrome.
 */
function AppNav() {
  const auth = useAuth();
  if (auth.status !== 'logged-in') return null;
  return (
    <nav className="app-nav">
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
    <div className="app-shell">
      <AppNav />
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/servers" element={<ServerListPage />} />
        <Route path="/servers/new" element={<ServerEditPage mode="create" />} />
        <Route path="/servers/:id/edit" element={<ServerEditPage mode="edit" />} />
        <Route path="/servers/:id" element={<SessionListPage />} />
        <Route path="/servers/:id/sessions/new" element={<SessionCreatePage />} />
        <Route path="/servers/:id/sessions/:sid" element={<TerminalPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
    </ToastProvider>
  );
}

import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { ServerListPage } from './pages/ServerListPage';
import { ServerEditPage } from './pages/ServerEditPage';
import { SessionListPage } from './pages/SessionListPage';
import { SessionCreatePage } from './pages/SessionCreatePage';
import { TerminalPage } from './pages/TerminalPage';

export default function App() {
  return (
    // app-shell extends #root's flex column so that pages can use `flex: 1`
    // to fill the viewport. Without it, nested `height: 100%` between the
    // router and the page collapses to 0 and xterm never gets a height.
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/servers" element={<ServerListPage />} />
        <Route path="/servers/new" element={<ServerEditPage mode="create" />} />
        <Route path="/servers/:id/edit" element={<ServerEditPage mode="edit" />} />
        <Route path="/servers/:id" element={<SessionListPage />} />
        <Route path="/servers/:id/sessions/new" element={<SessionCreatePage />} />
        <Route path="/servers/:id/sessions/:sid" element={<TerminalPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

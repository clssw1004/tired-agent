import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './store/AuthContext';
import { ServerProvider } from './store/ServerContext';
import './styles.css';

// Disable StrictMode in dev to avoid double-effect issues with subscriptions
// (causes "submit called twice" type problems in some setups)
const USE_STRICT = false;

ReactDOM.createRoot(document.getElementById('root')!).render(
  USE_STRICT ? (
    <React.StrictMode>
      <AuthProvider>
        <ServerProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ServerProvider>
      </AuthProvider>
    </React.StrictMode>
  ) : (
    <AuthProvider>
      <ServerProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </ServerProvider>
    </AuthProvider>
  ),
);

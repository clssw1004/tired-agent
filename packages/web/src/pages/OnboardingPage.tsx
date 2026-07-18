import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AutoRegisterTab } from '../components/onboarding/AutoRegisterTab';
import { ManualAddTab } from '../components/onboarding/ManualAddTab';

type Tab = 'auto' | 'manual';

/**
 * Onboarding page — guides the user through adding a new agent to this
 * Manager, via either auto-registration (one-liner) or a manual install.
 * Mounted at /onboarding.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('auto');

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 720 }}>
        <div className="page-header">
          <div>
            <div className="page-title">Add an Agent</div>
            <div className="page-subtitle">
              Onboard a new machine to control via this Manager
            </div>
          </div>
          <div className="toolbar">
            <button onClick={() => navigate('/servers')}>← Agents</button>
          </div>
        </div>

        <div className="onboarding-tabs">
          <button
            className={tab === 'auto' ? 'onboarding-tab active' : 'onboarding-tab'}
            onClick={() => setTab('auto')}
          >
            Auto-register
          </button>
          <button
            className={tab === 'manual' ? 'onboarding-tab active' : 'onboarding-tab'}
            onClick={() => setTab('manual')}
          >
            Manual add
          </button>
        </div>

        {tab === 'auto' ? <AutoRegisterTab /> : <ManualAddTab />}
      </div>
    </div>
  );
}

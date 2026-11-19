import { useCallback, useEffect, useState } from 'react';
import type { AppView } from '../../shared/types.ts';
import { call } from '../api.ts';
import { ChatIcon, HealthIcon, HomeIcon, PlanIcon } from './icons.tsx';
import { startOfDay } from './model.ts';
import { ChatScreen } from './screens/Chat.tsx';
import { HealthScreen } from './screens/Health.tsx';
import { MeasureScreen } from './screens/Measure.tsx';
import { NewPlanScreen } from './screens/NewPlan.tsx';
import { PatientPicker } from './screens/Picker.tsx';
import { PlanScreen } from './screens/Plan.tsx';
import { TodayScreen } from './screens/Today.tsx';

// The patient app. Routing uses the URL hash (#/plan, #/measure/…), so the
// server only serves /app/ and the app works when installed.

const PATIENT_KEY = 'mmd.patient';

function readStoredPatient(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('patient');
  try {
    if (fromUrl) localStorage.setItem(PATIENT_KEY, fromUrl);
    return fromUrl ?? localStorage.getItem(PATIENT_KEY);
  } catch {
    return fromUrl;
  }
}

function useHashPath() {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [path, setPath] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setPath(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

export interface ScreenProps {
  view: AppView;
  patientGuid: string;
  today: number;
  refresh: () => Promise<void>;
}

const TABS = [
  { href: '#/', label: 'Today', match: (p: string) => p === '/', Icon: HomeIcon },
  { href: '#/plan', label: 'My plan', match: (p: string) => p.startsWith('/plan'), Icon: PlanIcon },
  { href: '#/health', label: 'Health', match: (p: string) => p.startsWith('/health'), Icon: HealthIcon },
  { href: '#/chat', label: 'Chat', match: (p: string) => p.startsWith('/chat'), Icon: ChatIcon },
];

export default function App() {
  const path = useHashPath();
  const [patientGuid, setPatientGuid] = useState<string | null>(readStoredPatient);
  const [view, setView] = useState<AppView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = startOfDay(Date.now());

  const refresh = useCallback(async () => {
    if (!patientGuid) return;
    try {
      setView(await call<AppView>('GET', `/api/app/${encodeURIComponent(patientGuid)}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your plan.');
    }
  }, [patientGuid]);

  useEffect(() => {
    setView(null);
    void refresh();
  }, [refresh]);

  const choose = (guid: string) => {
    try {
      localStorage.setItem(PATIENT_KEY, guid);
    } catch {
      // Private mode: the choice lasts until the page closes.
    }
    setPatientGuid(guid);
    window.location.hash = '#/';
  };

  if (!patientGuid || path === '/patients') {
    return (
      <div className="app">
        <PatientPicker onChoose={choose} current={patientGuid} />
      </div>
    );
  }
  if (error && !view) {
    return (
      <div className="app">
        <main className="screen">
          <p className="error" role="alert">
            {error}
          </p>
          <a className="btn" href="#/patients">
            Choose patient
          </a>
        </main>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="app">
        <main className="screen muted">Loading …</main>
      </div>
    );
  }

  const props: ScreenProps = { view, patientGuid, today, refresh };
  const measure = /^\/measure\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path);
  const newPlan = /^\/new-plan\/([^/]+)$/.exec(path);

  let screen;
  let tabs = true;
  if (measure) {
    tabs = false;
    screen = (
      <MeasureScreen
        {...props}
        requestGuid={decodeURIComponent(measure[1])}
        activityKey={decodeURIComponent(measure[2])}
        stopIndex={Number(measure[3])}
      />
    );
  } else if (newPlan) {
    tabs = false;
    screen = <NewPlanScreen {...props} requestGuid={decodeURIComponent(newPlan[1])} />;
  } else if (path.startsWith('/plan')) screen = <PlanScreen {...props} />;
  else if (path.startsWith('/health')) screen = <HealthScreen {...props} />;
  else if (path.startsWith('/chat')) screen = <ChatScreen {...props} />;
  else screen = <TodayScreen {...props} />;

  return (
    <div className="app">
      {screen}
      {tabs && (
        <nav className="tabbar" aria-label="Tabs">
          {TABS.map(({ href, label, match, Icon }) => (
            <a key={href} className="tab" href={href} aria-current={match(path) ? 'page' : undefined}>
              <Icon />
              {label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

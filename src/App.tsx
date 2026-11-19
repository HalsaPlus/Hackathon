import { useEffect, useState } from 'react';
import { ConnectionsPage } from './pages/ConnectionsPage.tsx';
import { PatientPage } from './pages/PatientPage.tsx';
import { PatientsPage } from './pages/PatientsPage.tsx';

// The admin console. Routing with the URL hash (#/, #/patient/<guid>,
// #/connection), so the server only ever has to serve index.html.

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

export default function App() {
  const path = useHashPath();
  const patientMatch = /^\/patient\/([^/]+)$/.exec(path);
  const section = path.startsWith('/connection') ? 'connection' : 'patients';

  let page;
  if (patientMatch) page = <PatientPage key={patientMatch[1]} guid={decodeURIComponent(patientMatch[1])} />;
  else if (section === 'connection') page = <ConnectionsPage />;
  else page = <PatientsPage />;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="#/" className="brand">
            <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
              <path d="M4 20 H10 L18 8 H24" className="brand-line" />
              <circle cx="4" cy="20" r="3.5" className="brand-stop" />
              <circle cx="14" cy="14" r="3.5" className="brand-stop" />
              <circle cx="24" cy="8" r="3.5" className="brand-stop" />
            </svg>
            MMD
          </a>
          <nav aria-label="Main menu">
            <a href="#/" aria-current={section === 'patients' ? 'page' : undefined}>
              Patients
            </a>
            <a href="#/connection" aria-current={section === 'connection' ? 'page' : undefined}>
              Connection
            </a>
            <a href="/app/">Patient app</a>
          </nav>
          <form method="post" action="/logout" className="logout">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </header>
      <main className="page">{page}</main>
      <footer className="footer">Synthetic data only. PDHC may not be used with real patient data.</footer>
    </>
  );
}

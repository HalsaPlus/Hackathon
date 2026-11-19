import { type ReactNode, useEffect, useState } from 'react';
import './phone-frame.css';

// On a wide screen (a laptop at the demo), the patient app is shown centred
// in a phone frame instead of stretched across the window: a 390 × 844 phone
// with a dynamic island, a status bar and a home indicator, scaled to fit the
// window. The app runs inside it in an iframe of /app/ itself, so it behaves
// exactly as on a phone (its own scrolling, the tab bar at the bottom).
//
// On a phone or a narrow window, and whenever /app/ is already inside a frame
// (the iframe here, or the phone on the start page), the app is shown as
// before: `children`, full screen.

const WIDE = '(min-width: 700px)';
const SCREEN = { width: 390, height: 844 };
const BEZEL = 12;
const PHONE = { width: SCREEN.width + 2 * BEZEL, height: SCREEN.height + 2 * BEZEL };
const MARGIN = 48;

function insideFrame() {
  try {
    return window.self !== window.top;
  } catch {
    return true; // A frame from another origin: never frame again.
  }
}

// The app inside the phone: marked so phone-frame.css can give it a phone's
// slim scrollbar that stops above the tab bar.
try {
  if ((window.frameElement as HTMLElement | null)?.classList.contains('pf-app')) document.documentElement.classList.add('pf-inside');
} catch {
  // A frame from another origin: not ours.
}

const clock = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function fit() {
  return Math.min(1, (window.innerHeight - MARGIN) / PHONE.height, (window.innerWidth - MARGIN) / PHONE.width);
}

function StatusIcons() {
  return (
    <svg className="pf-icons" width="68" height="14" viewBox="0 0 68 14" aria-hidden="true">
      {/* Signal */}
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 5} y={10 - i * 3} width="3.4" height={4 + i * 3} rx="1" />
      ))}
      {/* Wi-Fi */}
      <path d="M31 4.2a9.5 9.5 0 0 1 12.6 0l-1.4 1.5a7.5 7.5 0 0 0-9.8 0Z M33.7 7.1a5.6 5.6 0 0 1 7.2 0l-1.4 1.5a3.6 3.6 0 0 0-4.4 0Z M37.3 12.4l-1.6-1.7a2.4 2.4 0 0 1 3.2 0Z" />
      {/* Battery */}
      <rect x="47" y="2" width="18" height="10" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.5" />
      <rect x="49" y="4" width="13" height="6" rx="1.5" />
      <rect x="66" y="5" width="1.6" height="4" rx="0.8" opacity="0.5" />
    </svg>
  );
}

export function PhoneFrame({ children }: { children: ReactNode }) {
  const [wide, setWide] = useState(() => !insideFrame() && window.matchMedia(WIDE).matches);
  const [scale, setScale] = useState(fit);
  const [time, setTime] = useState(clock);
  // The address when the frame opened: patient, ?asOf= and screen carry over.
  const [src] = useState(() => window.location.href);

  useEffect(() => {
    if (insideFrame()) return;
    const query = window.matchMedia(WIDE);
    const change = () => setWide(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  // A new #/screen in the window's address opens that screen in the phone.
  useEffect(() => {
    if (!wide) return;
    const follow = () => {
      const app = document.querySelector<HTMLIFrameElement>('iframe.pf-app')?.contentWindow;
      if (app) app.location.hash = window.location.hash;
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [wide]);

  useEffect(() => {
    if (!wide) return;
    const resize = () => setScale(fit());
    resize();
    window.addEventListener('resize', resize);
    const timer = window.setInterval(() => setTime(clock()), 15_000);
    return () => {
      window.removeEventListener('resize', resize);
      window.clearInterval(timer);
    };
  }, [wide]);

  if (!wide) return <>{children}</>;

  return (
    <div className="pf-stage">
      <div className="pf-fit" style={{ width: PHONE.width * scale, height: PHONE.height * scale }}>
        <div className="pf-phone" style={{ width: PHONE.width, height: PHONE.height, padding: BEZEL, transform: `scale(${scale})` }}>
          <span className="pf-button pf-button-action" aria-hidden="true" />
          <span className="pf-button pf-button-up" aria-hidden="true" />
          <span className="pf-button pf-button-down" aria-hidden="true" />
          <span className="pf-button pf-button-side" aria-hidden="true" />
          <div className="pf-screen">
            <div className="pf-status" aria-hidden="true">
              <span className="pf-time">{time}</span>
              <span className="pf-island" />
              <StatusIcons />
            </div>
            <iframe className="pf-app" src={src} title="MMD patient app" />
            <div className="pf-home-bar" aria-hidden="true">
              <span className="pf-home" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

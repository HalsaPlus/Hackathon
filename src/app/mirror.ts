// Mirror mode for the demo: one person uses the app as Andrea on their own
// device ("drive"), and the stage shows every step of it as if someone were
// using the phone there ("follow"). Roles come from the address:
// /phone?role=drive and /phone?role=follow (read from the /phone page around
// the app's iframe), or /app/?role=…. Without a role nothing here runs.
//
// The role can change during the demo: the "Take control  D" button on
// /phone (or the D key) makes this browser the driver and the previous driver
// a follower; "Hand over  D" makes it a follower.
//
// The driver sends, every 50 ms and only when something changed: the screen
// (hash route), the chat input's draft, the scroll position (as a fraction),
// the sliders, and the last button pressed. The follower applies it, and
// ignores its own keyboard and mouse while a driver is active, so the stage
// looks like a normal phone. The data itself (a sent message, a consent
// decision) arrives through the live updates as usual.

export type MirrorRole = 'drive' | 'follow';

export interface MirrorState {
  hash: string;
  draft: string | null;
  scroll: number;
  sliders: Record<string, string>;
  press: { label: string; at: number } | null;
}

const roleIn = (search: string): MirrorRole | null => {
  const role = new URLSearchParams(search).get('role');
  return role === 'drive' || role === 'follow' ? role : null;
};

export function mirrorRole(): MirrorRole | null {
  if (typeof window === 'undefined') return null;
  const own = roleIn(window.location.search);
  if (own) return own;
  try {
    if (window.parent !== window) return roleIn(window.parent.location.search);
  } catch {
    // Another origin around us: no role.
  }
  return null;
}

const labelOf = (el: Element) => (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const scroller = () => document.scrollingElement ?? document.documentElement;

export function readState(press: MirrorState['press']): MirrorState {
  const el = scroller();
  const max = el.scrollHeight - el.clientHeight;
  const input = document.getElementById('chat-message') as HTMLInputElement | null;
  return {
    hash: window.location.hash || '#/',
    draft: input ? input.value : null,
    scroll: max > 0 ? Math.round((el.scrollTop / max) * 1000) / 1000 : 0,
    sliders: Object.fromEntries([...document.querySelectorAll<HTMLInputElement>('input[type="range"][id]')].map((i) => [i.id, i.value])),
    press,
  };
}

/** Sets a React-controlled input's value as if typed, so React's onChange runs. */
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

interface MirrorIo {
  sendState: (state: MirrorState & Record<string, unknown>) => void;
  sendRole: (role: MirrorRole) => void;
  onMessage: (callback: (message: { type: string; [key: string]: unknown }) => void) => () => void;
}

/** The "Take control  D" button on /phone, outside the phone (same origin), if there is one. */
function takeOverButton(): HTMLButtonElement | null {
  try {
    return (window.parent !== window ? window.parent.document.getElementById('takeover') : null) as HTMLButtonElement | null;
  } catch {
    return null;
  }
}

const editing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Mirror mode with a role that can change: "Take control" (button or D)
 * makes this browser the driver, and the server makes the previous driver a
 * follower; "Hand over" makes it a follower. Starts with ?role=… .
 */
export function startMirror(io: MirrorIo) {
  const initial = mirrorRole();
  if (!initial) return () => undefined;
  let role: MirrorRole = initial;
  let driverPresent = false;
  let stopCurrent: () => void = () => undefined;
  const button = takeOverButton();

  const render = () => {
    if (!button) return;
    button.hidden = false;
    const label = button.firstChild;
    if (label && label.nodeType === Node.TEXT_NODE) label.textContent = role === 'drive' ? 'Hand over' : 'Take control';
  };
  const become = (next: MirrorRole) => {
    stopCurrent();
    role = next;
    stopCurrent = next === 'drive' ? startDriver(io.sendState) : startFollower(io.onMessage, () => driverPresent);
    render();
  };
  const toggle = () => {
    const next: MirrorRole = role === 'drive' ? 'follow' : 'drive';
    io.sendRole(next);
    become(next);
  };

  // D toggles, in the /phone page and in the app; not while the driver types.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'd' && event.key !== 'D') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (role === 'drive' && editing(event.target)) return;
    event.preventDefault();
    toggle();
  };
  const windows: Window[] = [window];
  try {
    if (window.parent !== window && window.parent.document) windows.push(window.parent);
  } catch {
    // Another origin around us.
  }
  for (const w of windows) w.addEventListener('keydown', onKey);
  const onClick = () => toggle();
  button?.addEventListener('click', onClick);

  const off = io.onMessage((message) => {
    if (message.type === 'driver') driverPresent = message.present === true;
    if (message.type === 'role' && (message.role === 'drive' || message.role === 'follow') && message.role !== role) become(message.role);
  });

  io.sendRole(initial);
  become(initial);
  return () => {
    off();
    stopCurrent();
    for (const w of windows) w.removeEventListener('keydown', onKey);
    button?.removeEventListener('click', onClick);
    if (button) button.hidden = true;
  };
}

function startDriver(sendState: (state: MirrorState & Record<string, unknown>) => void) {
  let press: MirrorState['press'] = null;
  let last = '';
  const onClick = (event: Event) => {
    const el = (event.target as Element | null)?.closest?.('button, a, [role="button"]');
    if (el) press = { label: labelOf(el), at: Date.now() };
  };
  document.addEventListener('click', onClick, true);
  const timer = setInterval(() => {
    const state = readState(press);
    const json = JSON.stringify(state);
    if (json === last) return;
    last = json;
    sendState(state as MirrorState & Record<string, unknown>);
  }, 50);
  return () => {
    clearInterval(timer);
    document.removeEventListener('click', onClick, true);
  };
}

function startFollower(onMessage: MirrorIo['onMessage'], driverPresent: () => boolean) {
  let driverAt = 0;
  let pressAt = 0;
  // The stage's own keyboard and mouse are ignored while a driver is active
  // (D still works: it takes control).
  const block = (event: Event) => {
    if (!event.isTrusted || !(driverPresent() || Date.now() - driverAt < 3000)) return;
    if (event instanceof KeyboardEvent && (event.key === 'd' || event.key === 'D')) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const blocked = ['keydown', 'beforeinput', 'pointerdown', 'mousedown', 'click', 'touchstart', 'wheel'] as const;
  for (const type of blocked) document.addEventListener(type, block, { capture: true, passive: false });

  const applyDom = (state: MirrorState) => {
    const input = document.getElementById('chat-message') as HTMLInputElement | null;
    if (input && state.draft !== null && input.value !== state.draft) {
      setValue(input, state.draft);
      if (state.draft) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(state.draft.length, state.draft.length);
      }
    }
    for (const [id, value] of Object.entries(state.sliders ?? {})) {
      const slider = document.getElementById(id) as HTMLInputElement | null;
      if (slider && slider.type === 'range' && slider.value !== value) setValue(slider, value);
    }
    const el = scroller();
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) {
      const top = Math.round(state.scroll * max);
      if (Math.abs(el.scrollTop - top) > 2) el.scrollTo({ top });
    }
    if (state.press && state.press.at !== pressAt) {
      pressAt = state.press.at;
      if (Date.now() - state.press.at < 3000) {
        const target = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => labelOf(el) === state.press!.label) as HTMLElement | undefined;
        if (target) {
          const before = target.style.boxShadow;
          target.style.boxShadow = '0 0 0 3px rgba(3, 212, 209, 0.85)';
          setTimeout(() => (target.style.boxShadow = before), 450);
        }
      }
    }
  };

  const off = onMessage((message) => {
    if (message.type !== 'mirror' || !message.state || typeof message.state !== 'object') return;
    const state = message.state as unknown as MirrorState;
    driverAt = Date.now();
    if (typeof state.hash === 'string' && state.hash !== (window.location.hash || '#/')) {
      window.location.hash = state.hash;
      // Let the new screen render, then fill it in.
      setTimeout(() => applyDom(state), 80);
      setTimeout(() => applyDom(state), 350);
    } else {
      applyDom(state);
    }
  });
  return () => {
    off();
    for (const type of blocked) document.removeEventListener(type, block, { capture: true });
  };
}

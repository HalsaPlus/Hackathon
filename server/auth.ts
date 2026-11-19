import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Express, Request } from 'express';

// One shared login: user "admin" and the password in ADMIN_PASSWORD.
// When deployed, the password is set as an environment variable on the host.
// Locally it is read from .env (see .env.example).

const USERNAME = 'admin';
const COOKIE_NAME = 'session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 20;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

const password = process.env.ADMIN_PASSWORD ?? '';

/** False when ADMIN_PASSWORD is missing. Nobody can sign in until it is set. */
export const loginConfigured = password.length > 0;

// Sessions are signed with a key derived from the password, so changing the
// password signs everyone out and there is only one secret to manage.
const signingKey = createHash('sha256').update(`session-key:${password}`).digest();

function sha256(value: string) {
  return createHash('sha256').update(value).digest();
}

/** Compares without leaking, through timing, how much of the value matched. */
export function safeEqual(a: string, b: string) {
  return timingSafeEqual(sha256(a), sha256(b));
}

function sign(expiresAt: number) {
  return createHmac('sha256', signingKey).update(`${USERNAME}.${expiresAt}`).digest('base64url');
}

function createSessionToken() {
  const expiresAt = Date.now() + SESSION_MS;
  return `${expiresAt}.${sign(expiresAt)}`;
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function hasValidSession(req: Request) {
  if (!loginConfigured) return false;
  const [expiresRaw, signature] = (readCookie(req, COOKIE_NAME) ?? '').split('.');
  const expiresAt = Number(expiresRaw);
  if (!signature || !Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false;
  return safeEqual(signature, sign(expiresAt));
}

// --- Limit on wrong guesses per address ---------------------------------------

const failedAttempts = new Map<string, { count: number; resetAt: number }>();

function isBlocked(ip: string) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(ip: string) {
  const now = Date.now();
  if (failedAttempts.size > 1000) {
    for (const [key, entry] of failedAttempts) {
      if (entry.resetAt < now) failedAttempts.delete(key);
    }
  }
  const entry = failedAttempts.get(ip);
  if (entry && entry.resetAt >= now) {
    entry.count += 1;
  } else {
    failedAttempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
  }
}

// --- Login page -----------------------------------------------------------------

const NOT_CONFIGURED = 'Sign-in is not configured. The password (ADMIN_PASSWORD) is missing on the server.';

/** Only a path on this site, so the login cannot be used to send people elsewhere. */
function safeNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value.slice(0, 300);
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function loginPage(message?: string, next = '/') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Sign in · MMD</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f6f7f9; --card: #ffffff; --text: #15181d; --muted: #5b6472;
        --border: #d5dae1; --accent: #1f5fbf; --accent-text: #ffffff; --error: #b3261e;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        line-height: 1.5;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #111418; --card: #1a1e24; --text: #eef0f3; --muted: #a3acb9;
          --border: #343b46; --accent: #7fb0ff; --accent-text: #0b1220; --error: #ff8a80;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        padding: 1rem; background: var(--bg); color: var(--text);
      }
      main {
        width: 100%; max-width: 22rem; padding: 2rem;
        background: var(--card); border: 1px solid var(--border); border-radius: 0.75rem;
      }
      h1 { margin: 0; font-size: 1.4rem; line-height: 1.2; }
      p { margin: 0.25rem 0 1.5rem; color: var(--muted); }
      label { display: block; margin-bottom: 0.25rem; font-size: 0.9rem; font-weight: 600; }
      input {
        width: 100%; margin-bottom: 1rem; padding: 0.6rem 0.7rem; font: inherit;
        color: inherit; background: transparent; border: 1px solid var(--border); border-radius: 0.4rem;
      }
      input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      button {
        width: 100%; padding: 0.65rem; font: inherit; font-weight: 600; cursor: pointer;
        color: var(--accent-text); background: var(--accent); border: 0; border-radius: 0.4rem;
      }
      .message { margin: 0 0 1rem; color: var(--error); font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <h1>MMD</h1>
      <p>Sign in to continue.</p>
      ${message ? `<div class="message" role="alert">${message}</div>` : ''}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;
}

// --- Routes -----------------------------------------------------------------------

/**
 * Adds the login page and requires a signed-in session for every route that is
 * registered after this call. Routes registered before it stay public.
 */
export function setupAuth(app: Express) {
  const sendLoginPage = (res: express.Response, status: number, message?: string, next = '/') => {
    res.status(status).set('Cache-Control', 'no-store').type('html').send(loginPage(message, next));
  };

  app.get('/login', (req, res) => {
    const next = safeNext(req.query.next);
    if (hasValidSession(req)) return res.redirect(next);
    sendLoginPage(res, 200, loginConfigured ? undefined : NOT_CONFIGURED, next);
  });

  app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const ip = req.ip ?? 'unknown';
    const next = safeNext((req.body ?? {}).next);
    if (!loginConfigured) return sendLoginPage(res, 503, NOT_CONFIGURED, next);
    if (isBlocked(ip)) {
      return sendLoginPage(res, 429, 'Too many attempts. Wait ten minutes and try again.', next);
    }

    const body: Record<string, unknown> = req.body ?? {};
    const usernameOk = safeEqual(typeof body.username === 'string' ? body.username : '', USERNAME);
    const passwordOk = safeEqual(typeof body.password === 'string' ? body.password : '', password);
    if (!usernameOk || !passwordOk) {
      recordFailure(ip);
      return sendLoginPage(res, 401, 'Wrong username or password.', next);
    }

    failedAttempts.delete(ip);
    res.cookie(COOKIE_NAME, createSessionToken(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_MS,
      path: '/',
    });
    res.redirect(303, next);
  });

  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
    res.redirect(303, '/login');
  });

  app.use((req, res, next) => {
    if (hasValidSession(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.status(401).send('Not signed in');
  });
}

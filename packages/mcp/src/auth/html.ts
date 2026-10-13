import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { ICON_SVG } from '../brand.js';

/** Escapes text for HTML content and attribute values. Every client-supplied string goes through it. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--text:#1b1b1a;--muted:#6b6b66;--line:#e3e3df;--accent:#7c3aed;--on-accent:#fff;--error:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1c1c1b;--text:#ececea;--muted:#a3a39e;--line:#2e2e2c;--accent:#a78bfa;--on-accent:#160a2e;--error:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:440px;margin:48px auto;padding:0 16px}.brand{display:flex;align-items:center;justify-content:center;gap:12px;margin:0 0 20px;font-weight:700;font-size:1.15rem;letter-spacing:-.01em}.brand svg{display:block;border-radius:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.25rem;margin:0 0 8px}p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}.error{color:var(--error)}
label{display:block;margin:16px 0 6px;font-weight:600}input[type=email],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;font:inherit}
.check{display:flex;gap:10px;align-items:flex-start;margin:14px 0;font-weight:400}.check input{margin-top:4px}
.actions{display:flex;gap:10px;margin-top:20px}.decide{flex-direction:row-reverse}button{flex:1;padding:11px;border-radius:10px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}code{font-size:.9em}
button.link{flex:none;padding:0;border:0;color:var(--accent);text-decoration:underline;cursor:pointer;background:none}.resend{margin-top:8px}
.who{border:1px solid var(--line);border-radius:10px;padding:12px;margin:16px 0}.warn{color:var(--error);font-size:.9rem}
.providers{display:grid;gap:10px;margin:18px 0 6px}.providers form{margin:0}.providers button{width:100%;font-weight:600}
.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.85rem;margin:14px 0 0}.or:before,.or:after{content:"";flex:1;border-top:1px solid var(--line)}`;

/**
 * Sends each form once: a second click while the first post is on its way would
 * replace the redirect back to the assistant with an error page. Reset when the
 * page comes back from the browser's cache (Back). Allowed by the CSP through
 * its hash, which a test recomputes.
 */
export const SUBMIT_ONCE_SCRIPT = "document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){if(f.dataset.sent){e.preventDefault();}f.dataset.sent='1';});});window.addEventListener('pageshow',function(){document.querySelectorAll('form').forEach(function(f){delete f.dataset.sent;});});";
export const SUBMIT_ONCE_HASH = 'sha256-JCXVJUy73IDSLEHxfePKr83x5QpiRpVvW0v4B2PeSqQ=';

/**
 * The CSP source that lets a form's redirect reach the client: `form-action`
 * applies to the redirect after a post too, and the consent form ends with a
 * redirect to the client's redirect URI. Its origin for a web client, its
 * scheme for a native app (`cursor:`); nothing when it cannot be expressed.
 */
export function redirectSource(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? url.protocol : null;
  } catch {
    return null;
  }
}

export function page(title: string, body: string, status = 200, headers?: Headers, formTargets: string[] = []): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Space Context</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><style>${STYLE}</style></head><body><main><div class="brand">${ICON_SVG.replace('<svg ', '<svg width="44" height="44" aria-hidden="true" ')}<span>Space Context</span></div><div class="card">${body}</div><p class="muted" style="text-align:center">Space Context · <a href="https://spacecontext.app/privacy/">Privacy</a></p></main><script>${SUBMIT_ONCE_SCRIPT}</script></body></html>`;
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  const formAction = ["'self'", ...formTargets].join(' ');
  responseHeaders.set('Content-Security-Policy', `default-src 'none'; script-src '${SUBMIT_ONCE_HASH}'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`);
  responseHeaders.set('X-Frame-Options', 'DENY');
  // same-origin, not no-referrer: with no-referrer browsers post forms with
  // `Origin: null`, and the forms are checked against their origin.
  responseHeaders.set('Referrer-Policy', 'same-origin');
  return new Response(html, { status, headers: responseHeaders });
}

/** Who is asking and where the access goes: the facts a consent page must show. */
function requester(consent: ConsentDescription): string {
  const domain = consent.clientDomain ? ` <span class="muted">(${escapeHtml(consent.clientDomain)})</span>` : '';
  const loopback = consent.redirectIsLoopback
    ? '<p class="warn">The access goes to a program on this computer. Approve only if you started this connection yourself.</p>'
    : '';
  return `<div class="who"><strong>${escapeHtml(consent.clientName)}</strong>${domain}<br><span class="muted">will receive access at ${escapeHtml(consent.redirectHost)}</span>${loopback}</div>`;
}

function hidden(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
}

/** Which providers this server can sign in with. */
export type SignInProviders = { google: boolean; apple: boolean };

/** Where a provider button's post ends up: its redirect to the provider is a form action too. */
const PROVIDER_ORIGINS = { google: 'https://accounts.google.com', apple: 'https://appleid.apple.com' } as const;

function providerButtons(input: { handle: string; oauth: string }, providers: SignInProviders): string {
  const button = (provider: 'google' | 'apple', label: string) =>
    `<form method="post" action="/authorize/${provider}">${hidden({ handle: input.handle, oauth: input.oauth })}<button type="submit">${label}</button></form>`;
  const buttons = [providers.apple ? button('apple', 'Continue with Apple') : '', providers.google ? button('google', 'Continue with Google') : ''].join('');
  return buttons ? `<div class="providers">${buttons}</div><p class="or">or with your email</p>` : '';
}

export function emailPage(
  input: { consent: ConsentDescription; handle: string; oauth: string; error?: string; email?: string; providers?: SignInProviders },
  headers?: Headers
): Response {
  const providers = input.providers ?? { google: false, apple: false };
  return page(
    'Connect',
    `<h1>Connect Space Context</h1>
<p>An AI assistant asks to read your spaces.</p>
${requester(input.consent)}
${providerButtons(input, providers)}
<form method="post" action="/authorize/code">
${hidden({ handle: input.handle, oauth: input.oauth })}
<label for="email">Your Space Context email</label>
<input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(input.email ?? '')}">
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<p class="muted">We will email you a sign-in code. Same account as the iPhone app.</p>
<div class="actions"><button class="primary" type="submit">Send code</button></div>
</form>`,
    input.error ? 400 : 200,
    headers,
    (['google', 'apple'] as const).filter((provider) => providers[provider]).map((provider) => PROVIDER_ORIGINS[provider])
  );
}

/**
 * The consent form. Approve is its first button, because Enter in the code field
 * submits the first one; `.decide` still shows it on the right, after Deny.
 */
export function consentPage(
  input: {
    consent: ConsentDescription;
    handle: string;
    oauth: string;
    email: string;
    error?: string;
    /** Signed in with a provider: no code to type, the identity travels as a one-time ticket. */
    ticket?: string;
    signedInWith?: string;
  },
  headers?: Headers
): Response {
  const signedIn = Boolean(input.ticket);
  return page(
    'Approve access',
    `${
      signedIn
        ? `<h1>Approve access</h1>
<p>Signed in with ${escapeHtml(input.signedInWith ?? 'your account')} as <strong>${escapeHtml(input.email)}</strong>.</p>`
        : `<h1>Check your email</h1>
<p>We sent a code to <strong>${escapeHtml(input.email)}</strong>.</p>`
    }
${requester(input.consent)}
<form method="post" action="/authorize/approve">
${hidden(signedIn ? { handle: input.handle, oauth: input.oauth, ticket: input.ticket! } : { handle: input.handle, oauth: input.oauth, email: input.email })}
${
  signedIn
    ? ''
    : `<label for="code">Code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="12">`
}
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<p><strong>It will be able to:</strong> read your spaces (areas, items, issues, key locations, instructions, facts and photos), search them and ask them questions. It cannot change or delete anything, and cannot spend money, unless you allow it below.</p>
<label class="check"><input type="checkbox" name="sensitive" value="1"><span>Also show <strong>sensitive values</strong> such as Wi-Fi passwords, door and alarm codes, and the narration of your videos.</span></label>
<label class="check"><input type="checkbox" name="scans" value="1"><span>Also let it <strong>scan spaces</strong> for you and check photos: each scan uses your free scan or is paid from your Space Context balance. Needs a card on file in your account (nothing is charged to add one).</span></label>
<p class="muted">You can revoke this access at any time from the console (API keys).</p>
<div class="actions decide"><button class="primary" type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="deny">Deny</button></div>
</form>
${
  signedIn
    ? ''
    : `<form method="post" action="/authorize/code" class="resend">
${hidden({ handle: input.handle, oauth: input.oauth, email: input.email })}
<p class="muted">No email? <button type="submit" class="link">Send a new code</button></p>
</form>`
}`,
    input.error ? 400 : 200,
    headers,
    // Approve and Deny both end with a redirect to the client.
    [redirectSource(input.consent.redirectUri)].filter((source): source is string => source !== null)
  );
}

/** Where a card is added: the console's Billing page, on the production site whatever this server's own URL. */
export const CONSOLE_BILLING_URL = 'https://spacecontext.app/developers/console/billing/';

/**
 * Scanning was allowed but the account has no card on file, so the API refused
 * a key that can scan. The same consent can be given again from here, on a new
 * handle and ticket: read-only at once, or with scanning once a card is added.
 */
export function cardRequiredPage(
  input: { consent: ConsentDescription; handle: string; oauth: string; email: string; ticket: string; sensitive: boolean },
  headers?: Headers
): Response {
  return page(
    'Scanning needs a card',
    `<h1>Scanning needs a card</h1>
<p>Signed in as <strong>${escapeHtml(input.email)}</strong>.</p>
${requester(input.consent)}
<p>To let an assistant <strong>scan spaces</strong>, your Space Context account needs a card on file. Adding one charges nothing (your bank may ask you to confirm it).</p>
<p><a href="${CONSOLE_BILLING_URL}" target="_blank" rel="noopener noreferrer">Add a card in the console</a> (Billing → Add a card), then come back to this page within ten minutes and try again.</p>
<form method="post" action="/authorize/approve">
${hidden({ handle: input.handle, oauth: input.oauth, ticket: input.ticket, ...(input.sensitive ? { sensitive: '1' } : {}) })}
<p>Or connect it <strong>read-only</strong>: it will read your spaces${input.sensitive ? ' (sensitive values included)' : ''}, search them and ask them questions, but cannot scan, change anything or spend money. You can allow scanning later by connecting again.</p>
<div class="actions"><button class="primary" type="submit" name="scans" value="0">Connect read-only</button><button type="submit" name="scans" value="1">Try again with scanning</button></div>
<p class="muted resend"><button type="submit" class="link" name="action" value="deny">Deny access</button></p>
</form>`,
    200,
    headers,
    // Connecting and denying both end with a redirect to the client.
    [redirectSource(input.consent.redirectUri)].filter((source): source is string => source !== null)
  );
}

/** Where keys are revoked: the console's API keys page, on the production site like Billing. */
export const CONSOLE_KEYS_URL = 'https://spacecontext.app/developers/console/keys/';

/**
 * The account already holds as many API keys as it may, so the key of this
 * connection could not be created: one has to go first.
 */
export function keyLimitPage(headers?: Headers): Response {
  return page(
    'Too many API keys',
    `<h1>Too many API keys</h1>
<p>Your Space Context account already has 20 active API keys, the most it can hold, and each connected assistant needs a key of its own.</p>
<p><a href="${CONSOLE_KEYS_URL}" target="_blank" rel="noopener noreferrer">Revoke the keys you no longer use in the console</a> (API keys), then start again from your assistant.</p>`,
    409,
    headers
  );
}

export function errorPage(title: string, message: string, status: number, headers?: Headers): Response {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, status, headers);
}

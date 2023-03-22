// OAuth 2.0 Authorization Code + PKCE for a public SPA client (RFC 7636). No client secret in the
// browser; tokens live in memory only, so an XSS can't lift a refresh token from localStorage.

export interface AuthConfig { issuer: string; clientId: string; redirectUri: string; scope: string }

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomString(byteLength = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Build the authorize URL and the values the callback must check. */
export async function beginLogin(cfg: AuthConfig, returnTo = '/') {
  const verifier = randomString(48);
  const state = randomString(16);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
  });
  return { url: `${cfg.issuer}/oauth2/authorize?${params}`, pending: { verifier, state, returnTo } };
}

/** Validate the redirect and exchange the code. Throws on state mismatch (CSRF / mix-up). */
export async function completeLogin(cfg: AuthConfig, callbackUrl: string, pending: { verifier: string; state: string },
                                    fetchImpl: typeof fetch = fetch) {
  const q = new URL(callbackUrl).searchParams;
  if (q.get('error')) throw new Error(`login failed: ${q.get('error_description') || q.get('error')}`);
  if (!q.get('state') || q.get('state') !== pending.state) throw new Error('state mismatch');
  const code = q.get('code');
  if (!code) throw new Error('no authorization code');
  const res = await fetchImpl(`${cfg.issuer}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, code_verifier: pending.verifier }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const t = await res.json();
  return { accessToken: t.access_token as string, expiresAt: Date.now() + (t.expires_in ?? 300) * 1000 };
}

/** Claims for display only; the API validates the token itself. */
export function decodeClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('not a JWT');
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
}

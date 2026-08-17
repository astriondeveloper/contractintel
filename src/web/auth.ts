/**
 * Who is making this request.
 *
 * Authentication is not done here and deliberately so. Azure Container Apps' built-in
 * Microsoft Entra integration terminates sign-in *in front of* the container and injects
 * the principal it vouched for as request headers. This application never sees a password,
 * never validates a token, and never issues one. It reads what the platform asserted.
 *
 * That arrangement has one sharp edge and this file exists to blunt it: **an injected
 * header is only trustworthy if something upstream is guaranteed to have set it.** With the
 * app reachable directly, anyone can send `X-MS-CLIENT-PRINCIPAL-NAME: whoever` and be
 * whoever. So identity is read only when `CIE_AUTH_MODE` says the platform is enforcing it,
 * and the default is to trust nothing:
 *
 *   entra   Trust the injected headers. Correct only when Container Apps authentication is
 *           configured and set to reject unauthenticated requests. `docs/DEPLOY.md` says how.
 *   dev     Trust CIE_DEV_USER. For a laptop. Refuses to start if NODE_ENV is production.
 *   none    No identity. The interface is read only and every write is refused. The default,
 *           because a misconfigured deployment should lose the ability to write rather than
 *           gain the ability to impersonate.
 *
 * Getting this wrong in the safe direction costs a 403 and a clear message. Getting it wrong
 * in the other direction means an audit trail full of names that mean nothing, which is worse
 * than no audit trail because it looks like one.
 */
import type { IncomingMessage } from 'node:http';

export type AuthMode = 'entra' | 'dev' | 'none';

export interface User {
  /** The stable handle. Assignment and audit rows key on this. */
  readonly principalName: string;
  readonly displayName: string;
  readonly email: string | null;
}

interface EntraClaim {
  readonly typ?: string;
  readonly val?: string;
}

interface EntraPrincipal {
  readonly auth_typ?: string;
  readonly name_typ?: string;
  readonly claims?: EntraClaim[];
}

/** Claim types Entra uses for the three things needed here, in preference order. */
const NAME_CLAIMS = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  'preferred_username',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'name',
];
const DISPLAY_CLAIMS = [
  'name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
];
const EMAIL_CLAIMS = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'email',
  'preferred_username',
];

export function authMode(): AuthMode {
  const raw = (process.env.CIE_AUTH_MODE ?? 'none').trim().toLowerCase();
  if (raw === 'entra') return 'entra';
  if (raw === 'dev') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'CIE_AUTH_MODE=dev with NODE_ENV=production. Dev mode trusts a name from an ' +
          'environment variable and must never run in a deployment. Set CIE_AUTH_MODE=entra.',
      );
    }
    return 'dev';
  }
  return 'none';
}

function firstClaim(claims: readonly EntraClaim[], wanted: readonly string[]): string | null {
  for (const type of wanted) {
    const found = claims.find((claim) => claim.typ === type && (claim.val ?? '').trim() !== '');
    if (found) return found.val!.trim();
  }
  return null;
}

/**
 * Decode the `X-MS-CLIENT-PRINCIPAL` header, which Container Apps sets to a base64 JSON
 * document of the token's claims. Malformed input answers null rather than throwing: a
 * header this application did not write is input, and input is never trusted to parse.
 */
function fromPrincipalHeader(encoded: string): User | null {
  let principal: EntraPrincipal;
  try {
    principal = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as EntraPrincipal;
  } catch {
    return null;
  }

  const claims = principal.claims ?? [];
  const principalName = firstClaim(claims, NAME_CLAIMS);
  if (principalName === null) return null;

  return {
    principalName,
    displayName: firstClaim(claims, DISPLAY_CLAIMS) ?? principalName,
    email: firstClaim(claims, EMAIL_CLAIMS),
  };
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The signed-in user, or null.
 *
 * Null is not an error. It means the platform did not vouch for anyone, so the interface
 * behaves exactly as it did before writes existed: everything readable, nothing writable.
 */
export function currentUser(request: IncomingMessage): User | null {
  const mode = authMode();

  if (mode === 'none') return null;

  if (mode === 'dev') {
    const name = (process.env.CIE_DEV_USER ?? '').trim();
    if (name === '') return null;
    return { principalName: name, displayName: name, email: null };
  }

  // entra. The full principal document first, since it carries the display name and email;
  // the flat header is the fallback for a configuration that only forwards the name.
  const encoded = header(request, 'x-ms-client-principal');
  if (encoded !== null) {
    const user = fromPrincipalHeader(encoded);
    if (user !== null) return user;
  }

  const name = header(request, 'x-ms-client-principal-name');
  if (name === null) return null;
  return { principalName: name, displayName: name, email: null };
}

/** Why a write was refused, in words a person can act on. */
export function whyNoWrite(): string {
  const mode = authMode();
  if (mode === 'none') {
    return (
      'This deployment has no authentication configured, so it cannot say who is acting and ' +
      'refuses to write. Spec section 20 requires an audit trail with an actor on it. Set ' +
      'CIE_AUTH_MODE=entra once Container Apps authentication is enforcing sign-in; ' +
      'docs/DEPLOY.md has the commands.'
    );
  }
  return (
    'No signed-in user on this request. Sign in and try again. If this keeps happening, ' +
    'Container Apps authentication is configured but not set to reject unauthenticated ' +
    'requests, so the principal header never arrives.'
  );
}

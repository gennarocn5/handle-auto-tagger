import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// Anything deployed sets NODE_ENV=production (hosts set it for you; set it
// yourself if yours does not). A .env file is for local development only: in
// production the real environment is authoritative, and a stray committed .env
// must not shadow it.
export const IS_PRODUCTION = process.env.NODE_ENV === 'production'

if (!IS_PRODUCTION) {
  try {
    process.loadEnvFile('.env')
  } catch {
    // No .env file (or an older Node) — use real environment variables.
  }
}

export const PORT = Number(process.env.PORT || 3000)

// Your own client, from https://publish.buffer.com/settings/api. No default on
// purpose: a fallback would mean users consenting to someone else's client.
// Trimmed because a pasted value easily carries a stray newline.
export const CLIENT_ID = process.env.BUFFER_CLIENT_ID?.trim()
if (!CLIENT_ID) {
  throw new Error('BUFFER_CLIENT_ID is not set. Create an app client at https://publish.buffer.com/settings/api and put its client ID in your .env (or your host\'s environment variables).')
}
export const CLIENT_SECRET = process.env.BUFFER_CLIENT_SECRET?.trim() || null

// OAuth redirect URIs must match what is registered with Buffer exactly.
// On Vercel, only the production deployment defaults to the stable production
// domain. Vercel sets VERCEL_PROJECT_PRODUCTION_URL on previews too, but a
// preview can't use that callback: the production host can't read the
// preview's session cookie, so the PKCE verifier would be lost. Previews get no
// default, and login stays off there unless REDIRECT_URI is set for them.
export function defaultRedirectUri(env = process.env) {
  if (env.VERCEL_ENV) {
    return env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}/callback`
      : null
  }
  return `https://localhost:${PORT}/callback`
}

// Buffer rejects a malformed redirect URI with a generic error, so catch the
// usual paste damage here and say what was wrong.
function sanitizeRedirectUri(value) {
  const [first, ...rest] = value.trim().split(/\s+/)
  if (rest.length) {
    console.warn(`REDIRECT_URI contained extra content and was truncated to ${first}. Check the environment variable — it should hold one URL and nothing else.`)
  }
  try {
    const url = new URL(first)
    if (url.protocol !== 'https:') console.warn(`REDIRECT_URI is not https (${first}); Buffer requires https.`)
    return url.toString()
  } catch {
    console.warn(`REDIRECT_URI is not a valid URL (${JSON.stringify(value)}); falling back to ${defaultRedirectUri()}.`)
    return defaultRedirectUri()
  }
}

// null means this deployment has no registered callback, so login is disabled.
export const REDIRECT_URI = process.env.REDIRECT_URI
  ? sanitizeRedirectUri(process.env.REDIRECT_URI)
  : defaultRedirectUri()

// The session cookie holding the PKCE verifier belongs to the host that started
// the login, so the callback has to land on that same host. Returns why login
// can't start from `host`, or null when it can.
export function loginUnavailableReason(host, redirectUri = REDIRECT_URI) {
  if (!redirectUri) {
    return 'Login is disabled on this deployment: it has no registered callback. ' +
      'Register this deployment\'s /callback URL with your app client and set REDIRECT_URI to it, or use the production deployment.'
  }
  const callbackHost = new URL(redirectUri).host
  if (host !== callbackHost) {
    return `Login is only available at https://${callbackHost}, the host of the registered callback (${redirectUri}). ` +
      'Starting it from another host would lose the session that carries the login.'
  }
  return null
}

// The OAuth flow spans two requests, so a key that changed on each boot would
// break any login that straddled a restart. Persist the development one.
const DEV_KEY_FILE = path.join(import.meta.dirname, '..', '.session-key')

function developmentSecret() {
  try {
    const existing = fs.readFileSync(DEV_KEY_FILE, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    // No key yet — generate one below.
  }

  const generated = crypto.randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(DEV_KEY_FILE, `${generated}\n`, { mode: 0o600 })
    console.warn(`SESSION_SECRET is not set; generated a development key in .session-key (gitignored). Sessions will survive restarts. Set a real one before deploying.`)
  } catch {
    console.warn('SESSION_SECRET is not set and .session-key could not be written; using a per-boot key. Sessions will end whenever the server restarts.')
  }
  return generated
}

// The key that seals the session cookie; 32 characters minimum. In production
// it must come from the environment — separate instances generating their own
// could never agree — so fail loudly instead of silently losing sessions.
function sessionSecret() {
  const secret = process.env.SESSION_SECRET?.trim()
  if (secret && secret.length >= 32) return secret

  if (IS_PRODUCTION) {
    throw new Error(
      secret
        ? 'SESSION_SECRET must be at least 32 characters. Generate one with `openssl rand -hex 32`.'
        : 'SESSION_SECRET is not set. Generate one with `openssl rand -hex 32` and add it to your host\'s environment variables.',
    )
  }
  if (secret) console.warn(`SESSION_SECRET is only ${secret.length} characters; 32 are required, so it is being ignored.`)
  return developmentSecret()
}

export const SESSION_SECRET = sessionSecret()

// Endpoints are published at https://auth.buffer.com/.well-known/openid-configuration
export const AUTH_URL = 'https://auth.buffer.com/auth'
export const TOKEN_URL = 'https://auth.buffer.com/token'
export const API_URL = 'https://api.buffer.com'

// Ask for exactly what the app uses: account:read (organizations and channels),
// posts:read (the sent-post history the directory is built from), posts:write
// (sending composed posts back to Buffer) and offline_access (refresh tokens).
export const SCOPES = 'account:read posts:read posts:write offline_access'

// Someone building against the API needs Buffer's own words to debug; someone
// using the deployed app must not see internals. Same call site, both audiences:
// the cause is appended in development and logged (only) in production.
export function withCause(message, cause) {
  return !IS_PRODUCTION && cause ? `${message} (${cause})` : message
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// Sessions live in a cookie sealed by iron-session, not in server memory: a
// serverless deploy gets a fresh process per invocation, so an in-memory store
// would lose the PKCE verifier between /auth/login and /callback.
import { getIronSession } from 'iron-session'
import { SESSION_SECRET } from './config.js'

const options = {
  password: SESSION_SECRET,
  cookieName: 'hat_sess',
  // This sealed, HttpOnly cookie holds the token pair for the runnable
  // starter. A 30-day TTL lets a refresh token keep the connection alive.
  ttl: 30 * 24 * 60 * 60,
  cookieOptions: {
    httpOnly: true,   // out of reach of JavaScript
    secure: true,     // HTTPS only — we run TLS locally too
    sameSite: 'lax',  // fine: our callback is a plain top-level GET
    path: '/',
  },
}

// Returns the session for this request. Mutate it, then `await session.save()`
// to write the cookie back; `await session.destroy()` clears it.
//
// This is deliberately the simplest viable pattern. It prevents page
// JavaScript from reading tokens, but cannot coordinate refreshes from two
// concurrent requests.
export function readSession(req, res) {
  return getIronSession(req, res, options)
}

import express from 'express'
import path from 'node:path'
import { HttpError, REDIRECT_URI, loginUnavailableReason, withCause } from './config.js'
import { readSession } from './session.js'
import {
  ACCOUNT_QUERY,
  CHANNELS_QUERY,
  CREATE_POST,
  buildAuthorizeUrl,
  buildHistoryQuery,
  historyVariables,
  readHistory,
  validateWindows,
  buildPostInput,
  createPkcePair,
  createState,
  exchangeCodeForTokens,
  graphql,
} from './buffer.js'

const app = express()
app.use(express.json({ limit: '200kb' }))

// Every route gets the session up front; routes that change it save explicitly.
app.use(async (req, res, next) => {
  try {
    req.session = await readSession(req, res)
    req.ctx = { req, res, session: req.session }
    next()
  } catch (err) {
    next(err)
  }
})

app.use(express.static(path.join(import.meta.dirname, '..', 'public'), { extensions: ['html'] }))

// Account data and authentication cookies must never be stored by a shared cache.
app.use(['/api', '/auth', '/callback'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store, private')
  next()
})

// Lets a route throw HttpError and have it become a real response.
const wrap = (handler) => async (req, res, next) => {
  try {
    await handler(req, res)
  } catch (err) {
    if (err.status) {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter))
      return res.status(err.status).json({ error: err.message, retryAfter: err.retryAfter || undefined })
    }
    next(err)
  }
}

app.get('/auth/login', wrap(async (req, res) => {
  const unavailable = loginUnavailableReason(req.get('host'))
  if (unavailable) return res.redirect(`/?error=${encodeURIComponent(unavailable)}`)

  const { verifier, challenge } = createPkcePair()
  const state = createState()

  // Note the asymmetry: we keep the verifier and the state, and send out only
  // the challenge (the hash) and the state.
  req.session.pkce = { codeVerifier: verifier, state }
  await req.session.save()

  res.redirect(buildAuthorizeUrl({ state, codeChallenge: challenge }))
}))

app.get('/callback', wrap(async (req, res) => {
  const { code, state, error, error_description: description } = req.query
  const pkce = req.session.pkce
  req.session.pkce = null   // one-time values — discard either way

  if (error) {
    await req.session.save()
    return res.redirect(`/?error=${encodeURIComponent(description || error)}`)
  }
  // CSRF check: only a callback this app started carries the state we stored.
  // A missing session and a mismatched state have different causes, so they get
  // different messages.
  // Both cases send the user back to the start with a plain-language note; the
  // technical cause goes to the logs.
  if (!pkce || state !== pkce.state) {
    console.warn(JSON.stringify({ event: 'oauth_callback_rejected', reason: !pkce ? 'no_session' : 'state_mismatch' }))
    await req.session.save()
    return res.redirect(`/?error=${encodeURIComponent('Your Buffer sign-in timed out or was interrupted. Click Connect Buffer to try again.')}`)
  }

  let tokens
  try {
    // The code is short-lived, so exchange it immediately.
    tokens = await exchangeCodeForTokens({ code, codeVerifier: pkce.codeVerifier })
  } catch (err) {
    console.error(JSON.stringify({ event: 'oauth_token_exchange_failed', code: err.oauthError, message: err.message }))
    await req.session.save()
    const message = withCause('Buffer could not complete the connection. Check your client configuration.', err.message)
    return res.redirect(`/?error=${encodeURIComponent(message)}`)
  }

  try {
    req.session.tokens = tokens
    await req.session.save()
  } catch (err) {
    // Saving can fail because of the tokens themselves (a sealed cookie that is
    // too large, say), so drop them before saving the cleared session.
    req.session.tokens = null
    await req.session.save()
    throw err
  }
  res.redirect('/')
}))

app.post('/auth/logout', wrap(async (req, res) => {
  await req.session.destroy()
  res.json({ connected: false })
}))

app.get('/api/session', wrap(async (req, res) => {
  // redirectUri is echoed back for debugging: curl this endpoint to see the
  // exact callback the app will send, rather than guessing from Buffer's
  // generic error page.
  if (!req.session.tokens) return res.json({ connected: false, redirectUri: REDIRECT_URI })

  const data = await graphql(req.ctx, ACCOUNT_QUERY)
  const { scope, connectedAt } = req.session.tokens
  res.json({
    connected: true,
    account: data.account,
    scope,
    redirectUri: REDIRECT_URI,
    connectedAt,
  })
}))

app.get('/api/channels', wrap(async (req, res) => {
  const organizationId = req.query.organizationId
  if (!organizationId) throw new HttpError(400, 'organizationId is required')

  const data = await graphql(req.ctx, CHANNELS_QUERY, { organizationId })
  res.json({ channels: data.channels.filter((c) => !c.isDisconnected) })
}))

// One page of sent-post history for up to MAX_WINDOWS_PER_REQUEST date windows.
// The browser drives the scan (which windows, which cursors) so that no single
// serverless invocation runs long, and nothing is stored here: post text passes
// through to the user's own browser, where the directory is built.
app.post('/api/history', wrap(async (req, res) => {
  const { organizationId } = req.body || {}
  if (!organizationId) throw new HttpError(400, 'organizationId is required')
  const windows = validateWindows(req.body.windows)

  const data = await graphql(req.ctx, buildHistoryQuery(windows.length), historyVariables(organizationId, windows))
  res.json({ results: readHistory(data, windows.length), rateLimit: req.ctx.rateLimit })
}))

// Send one composed post to one channel: queue, exact time, or draft.
app.post('/api/posts', wrap(async (req, res) => {
  const { channelId, organizationId, text, mediaUrl, when = 'queue', dueAt } = req.body || {}
  if (!channelId) throw new HttpError(400, 'channelId is required')
  if (!organizationId) throw new HttpError(400, 'organizationId is required')
  if (!text?.trim()) throw new HttpError(400, 'text is required')
  if (!['queue', 'schedule', 'draft'].includes(when)) throw new HttpError(400, 'when must be queue, schedule or draft')
  let due = null
  if (when === 'schedule') {
    const d = new Date(dueAt)
    if (Number.isNaN(+d)) throw new HttpError(400, 'Pick a date and time to schedule')
    if (d.getTime() < Date.now() + 60_000) throw new HttpError(400, 'The scheduled time has to be in the future')
    due = d.toISOString()
  }
  // Buffer fetches the file when the post publishes, so the URL has to be
  // public and served over https.
  if (mediaUrl?.trim() && !/^https:\/\//i.test(mediaUrl.trim())) {
    throw new HttpError(400, 'Media URL must be a public https link')
  }

  // `service` controls required metadata, so do not trust it from the browser.
  const channels = (await graphql(req.ctx, CHANNELS_QUERY, { organizationId })).channels
  const channel = channels.find((candidate) => candidate.id === channelId && !candidate.isDisconnected)
  if (!channel) throw new HttpError(400, 'Select a connected channel in the chosen organization')

  const result = (await graphql(req.ctx, CREATE_POST, {
    input: buildPostInput({
      channelId,
      service: channel.service,
      text: text.trim(),
      mediaUrl: mediaUrl?.trim() || null,
      when,
      dueAt: due,
    }),
  })).createPost

  // A typed error comes back as data, not as a thrown exception. Buffer's own
  // reason (too long for the network, media required, limit reached) is what
  // the user needs to fix it, so it is passed through.
  if (!result?.post) {
    console.warn(JSON.stringify({ event: 'buffer_post_rejected', message: result?.message }))
    throw new HttpError(400, result?.message || 'Buffer could not create that post.')
  }

  res.json({ post: result.post })
}))

// Misconfiguration (a missing SESSION_SECRET, for instance) should read as a
// clear message instead of an opaque platform 500.
app.use((err, _req, res, next) => {
  // Too late for a clean response; let Express close the connection.
  if (res.headersSent) return next(err)
  console.error(JSON.stringify({ event: 'unhandled_request_error', name: err.name, message: err.message }))
  res.status(500).json({ error: withCause('Something went wrong. Please try again.', err.message) })
})

export default app

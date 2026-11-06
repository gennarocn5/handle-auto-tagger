import crypto from 'node:crypto'
import {
  API_URL,
  AUTH_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  HttpError,
  REDIRECT_URI,
  SCOPES,
  TOKEN_URL,
  withCause,
} from './config.js'

/* ------------------------------------------------------------- oauth flow */

// The verifier is the secret. Its SHA-256 digest is the challenge, and only the
// challenge is ever sent to Buffer — the verifier stays on this server until
// the token exchange, which is what makes a stolen authorization code useless.
export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Random value echoed back by Buffer on the callback. If it doesn't match what
// we handed out, the callback didn't come from a flow we started.
export function createState() {
  return crypto.randomBytes(16).toString('base64url')
}

export function buildAuthorizeUrl({ state, codeChallenge }) {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',          // selects the Authorization Code flow
    scope: SCOPES,                  // space-separated
    state,
    code_challenge: codeChallenge,  // the hash — never the verifier
    code_challenge_method: 'S256',  // tells Buffer the challenge is a SHA-256 hash
    prompt: 'consent',
  }).toString()
  return url.toString()
}

// What the token endpoint's error codes usually mean in practice. Naming the
// likely cause saves the reader a trip through the OAuth spec.
const TOKEN_ERROR_HINTS = {
  invalid_client: 'set BUFFER_CLIENT_SECRET for a confidential client, or omit it entirely for a public one',
  invalid_grant: 'the code was already used or has expired, or redirect_uri differs from the authorize request',
  invalid_scope: 'a requested scope is not enabled on this app client',
  unsupported_grant_type: 'this client is not allowed to use that grant type',
}

// The authorization server advertises only "none" and "client_secret_post", so
// the secret always goes in the form body — never HTTP Basic.
export async function requestTokens(params, previous = null) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params })
  if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET)

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = await res.json().catch(() => ({}))

  if (!res.ok || json.error) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`
    const hint = TOKEN_ERROR_HINTS[json.error]
    const error = new Error(hint ? `${detail} — ${hint}` : detail)
    error.oauthError = json.error
    throw error
  }

  return {
    accessToken: json.access_token,
    // Buffer replaces a refresh token when it is used. Never retain the old
    // value after a successful refresh.
    refreshToken: json.refresh_token || null,
    scope: json.scope || previous?.scope,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 30_000,
    connectedAt: previous?.connectedAt || Date.now(),
  }
}

// Trade the one-time code for tokens. This is where the code_verifier is
// finally revealed: Buffer re-hashes it, compares it to the challenge from the
// authorize step, and only trusts us if they match.
export async function exchangeCodeForTokens({ code, codeVerifier }) {
  const tokens = await requestTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,   // must byte-match the authorize request
    code_verifier: codeVerifier,
  })
  if (!tokens.refreshToken) throw new Error('Buffer did not return a refresh token; enable offline_access for this app client')
  return tokens
}

export async function refreshTokens(previous) {
  const replacement = await requestTokens({
    grant_type: 'refresh_token',
    refresh_token: previous.refreshToken,
  }, previous)

  // A replacement is required for a rotating-token flow. Continuing with the
  // old token would make a later failure hard to diagnose and unsafe to retry.
  if (!replacement.refreshToken) throw new Error('Buffer did not return a replacement refresh token')
  return replacement
}

// The gate every API call passes through. It saves a rotated token pair before
// returning, so the next request uses Buffer's replacement refresh token.
async function accessToken(ctx) {
  const tokens = ctx.session.tokens
  if (!tokens) throw new HttpError(401, 'Not connected to Buffer')
  if (Date.now() < tokens.expiresAt) return tokens.accessToken

  if (!tokens.refreshToken) {
    ctx.session.tokens = null
    await ctx.session.save()
    throw new HttpError(401, 'Your Buffer session expired. Connect again to continue.')
  }

  try {
    ctx.session.tokens = await refreshTokens(tokens)
    await ctx.session.save()
    return ctx.session.tokens.accessToken
  } catch (err) {
    console.warn(JSON.stringify({ event: 'buffer_token_refresh_failed', code: err.oauthError }))
    ctx.session.tokens = null
    await ctx.session.save()
    throw new HttpError(401, 'Your Buffer session expired. Connect again to continue.')
  }
}

/* --------------------------------------------------------------- graphql */
// Everything the app reads or writes goes through one GraphQL endpoint at
// https://api.buffer.com, with the access token in an Authorization header.

// Rate limits are per client, so every user of this app shares one quota. A
// well-behaved client reads Retry-After and backs off rather than hammering.
const MAX_BACKOFF_SECONDS = 5

export async function graphql(ctx, query, variables, { backedOff = false } = {}) {
  const token = await accessToken(ctx)
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json().catch(() => null)
  // Surface the remaining quota so the browser can pace a long history scan.
  ctx.rateLimit = res.headers.get('RateLimit') || ctx.rateLimit || null

  if (res.status === 401) {
    ctx.session.tokens = null
    await ctx.session.save()
    throw new HttpError(401, 'Buffer rejected the access token — reconnect')
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 0
    // Wait out a short reset once. A long one is not worth holding a request
    // open for — serverless functions bill wall-clock time and time out — so
    // it is reported instead, with the wait the API asked for.
    if (!backedOff && retryAfter > 0 && retryAfter <= MAX_BACKOFF_SECONDS) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
      return graphql(ctx, query, variables, { backedOff: true })
    }
    const error = new HttpError(429, `Buffer API rate limit reached${retryAfter ? ` — try again in ${retryAfter}s` : ''}`)
    error.retryAfter = retryAfter
    throw error
  }

  // A GraphQL request that fails still comes back as HTTP 200. The real status
  // is in the `errors` array, under extensions.code.
  if (!res.ok || json?.errors?.length) {
    const failure = json?.errors?.[0]
    const code = failure?.extensions?.code
    console.error(JSON.stringify({ event: 'buffer_api_error', status: res.status, code, message: failure?.message }))
    throw new HttpError(502, withCause(
      'Buffer could not complete the request. Please try again.',
      [code, failure?.message].filter(Boolean).join(': ') || `HTTP ${res.status}`,
    ))
  }
  return json.data
}

export const ACCOUNT_QUERY = `
  query Account {
    account {
      id
      email
      name
      organizations { id name }
    }
  }
`

// A "channel" is any social account connected to Buffer — a LinkedIn profile,
// an Instagram account, and so on. We scope the query to one organization.
export const CHANNELS_QUERY = `
  query Channels($organizationId: OrganizationId!) {
    channels(input: { organizationId: $organizationId }) {
      id
      name
      displayName
      service
      avatar
      isDisconnected
      isQueuePaused
    }
  }
`

// createPost returns a UNION: either PostActionSuccess or one of several typed
// error types. MutationError is the interface all of those errors implement, so
// a single `... on MutationError` block catches every one of them, and a failed
// operation arrives as data you can show the user rather than as an exception.
export const CREATE_POST = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess {
        post { id text status dueAt channelId }
      }
      ... on MutationError { message }
    }
  }
`

// Networks do not all accept the same post. These are the metadata fields the
// schema marks non-null for a service, so a post to that service fails
// validation without them. Every other service needs no metadata at all.
const REQUIRED_METADATA = {
  instagram: { type: 'post', shouldShareToFeed: true },
  facebook: { type: 'post' },
  googlebusiness: { type: 'whats_new' },
}

// PostInputMetaData calls Google Business Profile `google`; every other service
// uses the same name the channel reports.
const METADATA_FIELD = { googlebusiness: 'google' }

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm']

// One hosted URL becomes one asset. Whether it is an image or a video changes
// how the networks treat it, and the extension is all there is to go on.
function assetsFor(mediaUrl) {
  if (!mediaUrl) return []
  const path = new URL(mediaUrl).pathname.toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.some((extension) => path.endsWith(extension))
  return [isVideo ? { video: { url: mediaUrl } } : { image: { url: mediaUrl } }]
}

// Assembles CreatePostInput. Two of its required fields are easy to miss:
// `assets` and `needsApproval` are non-null in the schema, so the mutation
// fails validation without them even when there is nothing to put there.
//
// when: 'queue' (next free slot), 'schedule' (exact dueAt), or 'draft'
// (saved to the channel's drafts, nothing publishes).
export function buildPostInput({ channelId, service, text, mediaUrl, when = 'queue', dueAt = null }) {
  const input = {
    channelId,
    text,
    assets: assetsFor(mediaUrl),
    needsApproval: false,
    schedulingType: 'automatic',
    mode: when === 'schedule' ? 'customScheduled' : 'addToQueue',
  }
  if (when === 'schedule') input.dueAt = dueAt
  if (when === 'draft') input.saveToDraft = true

  const fields = { ...REQUIRED_METADATA[service] }
  // YouTube shows a title rather than the caption, so it gets the first line.
  if (service === 'youtube') fields.title = text.split('\n')[0].slice(0, 100)

  if (Object.keys(fields).length) {
    input.metadata = { [METADATA_FIELD[service] || service]: fields }
  }

  return input
}

/* ------------------------------------------------------- history scanning */
// The directory is built from what the user has already sent. A new app client
// starts with a small request budget (100 per 15 minutes, shared by everyone
// using the app), so instead of paging one channel-month at a time the scan
// packs several date windows into a single request using GraphQL aliases.
// Each alias is its own `posts` connection with its own cursor.

export const MAX_WINDOWS_PER_REQUEST = 8
const ID_PATTERN = /^[a-f\d]{24}$/i

export function validateWindows(windows) {
  if (!Array.isArray(windows) || !windows.length) throw new HttpError(400, 'windows is required')
  if (windows.length > MAX_WINDOWS_PER_REQUEST) throw new HttpError(400, `At most ${MAX_WINDOWS_PER_REQUEST} windows per request`)
  return windows.map((w) => {
    const channelIds = Array.isArray(w.channelIds) ? w.channelIds : []
    if (!channelIds.length || channelIds.length > 50 || !channelIds.every((id) => ID_PATTERN.test(id))) {
      throw new HttpError(400, 'Each window needs 1-50 valid channelIds')
    }
    const start = new Date(w.start), end = new Date(w.end)
    if (Number.isNaN(+start) || Number.isNaN(+end) || start >= end) throw new HttpError(400, 'Each window needs a valid start before end')
    const after = typeof w.after === 'string' && w.after.length < 500 ? w.after : null
    return { channelIds, start: start.toISOString(), end: end.toISOString(), after }
  })
}

export function buildHistoryQuery(count) {
  const defs = ['$organizationId: OrganizationId!']
  const fields = []
  for (let i = 0; i < count; i++) {
    defs.push(`$c${i}: [ChannelId!]`, `$s${i}: DateTime`, `$e${i}: DateTime`, `$a${i}: String`)
    fields.push(`  w${i}: posts(
    first: 100
    after: $a${i}
    input: {
      organizationId: $organizationId
      filter: { status: [sent], channelIds: $c${i}, dueAt: { start: $s${i}, end: $e${i} } }
      sort: [{ field: dueAt, direction: desc }]
    }
  ) {
    edges { node { id text dueAt createdAt channelId } }
    pageInfo { hasNextPage endCursor }
  }`)
  }
  return `query History(${defs.join(', ')}) {\n${fields.join('\n')}\n}`
}

export function historyVariables(organizationId, windows) {
  const vars = { organizationId }
  windows.forEach((w, i) => {
    vars[`c${i}`] = w.channelIds
    vars[`s${i}`] = w.start
    vars[`e${i}`] = w.end
    vars[`a${i}`] = w.after
  })
  return vars
}

export function readHistory(data, count) {
  const results = []
  for (let i = 0; i < count; i++) {
    const conn = data[`w${i}`]
    results.push({
      posts: (conn?.edges || []).map((e) => e.node),
      hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
      endCursor: conn?.pageInfo?.endCursor || null,
    })
  }
  return results
}

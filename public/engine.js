// The handle engine. Pure functions, no DOM and no network, so the same file
// runs in the browser and under `node --test`.
//
//   extractMentions  → finds @handles in one caption, using each network's rules
//   buildDirectory   → turns a year of sent posts into entities: one row per
//                      account, with its handle on every network it was tagged on
//   findMatches      → finds directory names/aliases inside a new caption
//   renderForService → rewrites a caption with the right handles for one network

/* --------------------------------------------------------------- networks */

// Buffer reports a channel's network as `service`. Several services share one
// handle namespace (none do today, but keep the indirection), so everything
// below is keyed by "family".
export const NETWORKS = {
  twitter: { family: 'x', label: 'X', limit: 280 },
  instagram: { family: 'instagram', label: 'Instagram', limit: 2200 },
  threads: { family: 'threads', label: 'Threads', limit: 500 },
  facebook: { family: 'facebook', label: 'Facebook', limit: 63206 },
  linkedin: { family: 'linkedin', label: 'LinkedIn', limit: 3000 },
  tiktok: { family: 'tiktok', label: 'TikTok', limit: 2200 },
  bluesky: { family: 'bluesky', label: 'Bluesky', limit: 300 },
  mastodon: { family: 'mastodon', label: 'Mastodon', limit: 500 },
  youtube: { family: 'youtube', label: 'YouTube', limit: 5000 },
  pinterest: { family: 'pinterest', label: 'Pinterest', limit: 500 },
  googlebusiness: { family: 'google', label: 'Google Business', limit: 1500 },
  startPage: { family: 'startpage', label: 'Start Page', limit: 10000 },
  substack: { family: 'substack', label: 'Substack', limit: 10000 },
}

export const FAMILY_LABEL = Object.fromEntries(
  Object.values(NETWORKS).map((n) => [n.family, n.label]),
)

// Display / preference order when picking a readable name for an entity.
export const FAMILY_ORDER = ['x', 'instagram', 'threads', 'tiktok', 'bluesky', 'linkedin', 'facebook', 'mastodon', 'youtube', 'pinterest', 'google', 'startpage', 'substack']

export function familyOf(service) {
  return NETWORKS[service]?.family || service || 'other'
}

/* --------------------------------------------------------------- mentions */

const NOT_AFTER = '(?<![A-Za-z0-9_@./\\\\])' // not inside an email, URL path or word
// Facebook (and some LinkedIn) mentions are stored by Buffer as @[id] or
// @[Name](urn), not as a readable handle.
const BRACKET = /@\[[^\]\n]{1,120}\](?:\([^)\n]{1,200}\))?/g

const PLAIN = {
  // X: 1-15 letters, digits, underscore
  x: new RegExp(`${NOT_AFTER}@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_@])`, 'g'),
  // Instagram / Threads / TikTok: letters, digits, underscore, inner dots
  instagram: new RegExp(`${NOT_AFTER}@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)(?![A-Za-z0-9_@])`, 'g'),
  // Bluesky: domain-style handles (name.bsky.social, brand.com)
  bluesky: new RegExp(`${NOT_AFTER}@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)`, 'gi'),
  // Mastodon: @user or @user@instance.tld
  mastodon: new RegExp(`${NOT_AFTER}@([A-Za-z0-9_]{1,30}(?:@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+)?)`, 'g'),
  other: new RegExp(`${NOT_AFTER}@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,38}[A-Za-z0-9_])?)(?![A-Za-z0-9_@])`, 'g'),
}
PLAIN.threads = PLAIN.instagram
PLAIN.tiktok = PLAIN.instagram

export function mentionKey(family, raw) {
  return `${family}:${raw.toLowerCase()}`
}

// Returns [{ raw, key, family, index, end }] in caption order.
export function extractMentions(text, service) {
  if (!text) return []
  const family = familyOf(service)
  const found = []
  const taken = []

  for (const m of text.matchAll(BRACKET)) {
    found.push({ raw: m[0], index: m.index, end: m.index + m[0].length })
    taken.push([m.index, m.index + m[0].length])
  }
  // On Facebook a typed "@Name" is just text; only Buffer's @[page] form tags.
  const re = family === 'facebook' ? null : new RegExp(PLAIN[family] || PLAIN.other)
  for (const m of re ? text.matchAll(re) : []) {
    const index = m.index
    if (taken.some(([a, b]) => index >= a && index < b)) continue
    found.push({ raw: `@${m[1]}`, index, end: index + m[0].length })
  }
  found.sort((a, b) => a.index - b.index)
  return found.map((f) => ({ ...f, family, key: mentionKey(family, f.raw) }))
}

export function isBracket(raw) {
  return raw.startsWith('@[')
}

/* ----------------------------------------------------------- text helpers */

const URL_RE = /https?:\/\/\S+/g

// NFKC folds the "𝐁𝐨𝐥𝐝" unicode letters social teams love back into ASCII.
export function words(text) {
  return (text || '')
    .normalize('NFKC')
    .replace(URL_RE, ' ')
    .replace(BRACKET, ' ')
    .replace(/@[\w.@-]+/g, ' ')
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu) || []
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n / Math.min(a.size, b.size)
}

function contextWords(text, mention, side, n = 4) {
  const slice = side === 'before'
    ? text.slice(Math.max(0, mention.index - 80), mention.index)
    : text.slice(mention.end, mention.end + 80)
  const w = words(slice)
  return side === 'before' ? w.slice(-n) : w.slice(0, n)
}

// "SouthAlabamaBSB" → "South Alabama BSB", "fiu.baseball" → "Fiu Baseball"
export function nameFromHandle(raw, vocab = null) {
  if (!raw) return ''
  if (isBracket(raw)) {
    const named = raw.match(/^@\[([^\]]+)\]\(/)
    if (named && !/^\d+$/.test(named[1])) return named[1]
    const inner = raw.slice(2, raw.indexOf(']'))
    return /^\d+$/.test(inner) ? '' : inner
  }
  let h = raw.replace(/^@/, '').replace(/@.*$/, '')
  if (h.includes('.') && /\.(bsky\.social|com|org|net|io|co)$/i.test(h)) h = h.split('.')[0]
  if (vocab?.suffixes?.length) {
    const lower = h.toLowerCase()
    // longest shared suffix; if it already starts with a capital, camel-case splitting handles it
    const suf = vocab.suffixes.find((x) => lower.endsWith(x) && lower.length - x.length >= 2)
    const at = suf ? h.length - suf.length : -1
    if (suf && !/[A-Z_.\-]/.test(h[at]) && !/[_.\-]/.test(h[at - 1])) h = `${h.slice(0, at)} ${h.slice(at)}`
  }
  h = h
    .replace(/[_.\-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  return h.split(' ').map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

/* ------------------------------------------------------- names from captions */

// People usually write the account's name right next to its tag:
//   "Fall Report: South Alabama … @SouthAlabamaBSB's roster"
//   "Congrats to Chris Burke (@ChrisBurke02)"
// So instead of splitting the handle, look in the captions where the handle
// was used for a capitalized phrase whose words spell out part of the handle,
// in order. "South Alabama" covers 12 letters of "southalabamabsb"; "LSU" is an
// acronym at the start of "lsubaseball". The phrase that explains the most of
// the handle, most often, wins.

const CONNECTORS = new Set(['of', 'and', '&', 'de', 'la', 'del', 'da', 'du', 'van', 'von', 'the'])
const STOP_STARTS = new Set(['the', 'a', 'an', 'and', 'of'])

function phraseRuns(text) {
  const clean = (text || '')
    .normalize('NFKC')
    .replace(URL_RE, ' | ')
    .replace(BRACKET, ' | ')
    .replace(/[@#][\w.]+/g, ' | ')
  const runs = []
  let run = []
  const flush = () => { if (run.length) runs.push(run); run = [] }
  for (const raw of clean.split(/\s+/)) {
    if (!raw) continue
    const lead = /^[("“'‘\[]/.test(raw)
    if (lead) flush()
    let w = raw.replace(/^[("“'‘\[]+/, '')
    const trail = /[)"”'’\],.:;!?|…–—/]+$/.test(w.replace(/['’]s$/i, ''))
    w = w.replace(/['’]s$/i, '').replace(/[)"”'’\],.:;!?|…–—/]+$/, '').replace(/['’]s$/i, '')
    if (!w) { flush(); continue }
    const capital = /^[\p{Lu}\d]/u.test(w) && /[\p{L}]/u.test(w)
    if (capital || (run.length && CONNECTORS.has(w.toLowerCase()))) run.push(w)
    else flush()
    if (trail) flush()
  }
  flush()
  // trim connectors from the ends
  return runs.map((r) => {
    while (r.length && CONNECTORS.has(r[0].toLowerCase())) r.shift()
    while (r.length && CONNECTORS.has(r[r.length - 1].toLowerCase())) r.pop()
    return r
  }).filter((r) => r.length)
}

const letters = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')

// How many letters of `core` (a handle, lowercased, letters only) this phrase
// accounts for, or 0 if any word in it doesn't belong.
export function phraseScore(words, core, vocab = NO_VOCAB) {
  let pos = 0, matched = 0, specific = 0
  const significant = words.filter((w) => !CONNECTORS.has(w.toLowerCase()))
  if (!significant.length || STOP_STARTS.has(words[0].toLowerCase())) return 0
  for (const w of words) {
    const lw = letters(w)
    if (!lw) continue
    if (CONNECTORS.has(w.toLowerCase())) { const at = core.indexOf(lw, pos); if (at >= 0) { pos = at + lw.length; matched += lw.length } continue }
    const at = core.indexOf(lw, pos)
    if (at < 0) {
      // "Vanderbilt" for @VandyBoys: a single word whose first 4+ letters open the handle
      if (words.length === 1 && lw.length >= 5 && !vocab.isGeneric(lw)) {
        let k = 0
        while (k < lw.length && k < core.length && lw[k] === core[k]) k++
        if (k >= 4) return k * 0.5
      }
      return 0
    }
    pos = at + lw.length
    matched += lw.length
    if (!vocab.isGeneric(lw)) specific += lw.length
  }
  if (!specific) return 0 // "Baseball", "State": words half your handles share
  const isAcronym = words.length === 1 && /^[\p{Lu}\d&]{2,6}$/u.test(words[0])
  if (matched >= 4 && Math.min(1, matched / vocab.denominator(core)) >= 0.5) return matched
  if (isAcronym && core.startsWith(letters(words[0]))) return Math.max(matched, 3.5)
  return 0
}

const NO_VOCAB = { isGeneric: () => false, denominator: (core) => core.length, suffixes: [] }

// What counts as "generic" depends on the account: for a baseball outlet it's
// "baseball", "bsb", "state"; for a music brand it'd be "music", "records".
// A word is generic when it shows up inside many of the handles you tag.
export function handleVocabulary(raws) {
  const cores = [...new Set(raws.filter((h) => h && !isBracket(h)).map((h) => letters(h.replace(/^@/, '').split('@')[0])))].filter((c) => c.length >= 3)
  const threshold = Math.max(3, Math.ceil(cores.length * 0.04))
  const suffixCount = new Map()
  for (const c of cores) for (let L = 3; L <= 10 && L <= c.length - 2; L++) {
    const x = c.slice(-L)
    suffixCount.set(x, (suffixCount.get(x) || 0) + 1)
  }
  const suffixes = [...suffixCount].filter(([, n]) => n >= threshold).map(([x]) => x).sort((a, b) => b.length - a.length)
  const cache = new Map()
  const isGeneric = (w) => {
    if (w.length < 3) return false
    if (!cache.has(w)) {
      let n = 0
      for (const c of cores) if (c.includes(w) && ++n >= threshold) break
      cache.set(w, n >= threshold)
    }
    return cache.get(w)
  }
  const denominator = (core) => {
    const suf = suffixes.find((x) => core.endsWith(x) && core.length - x.length >= 2)
    return Math.max(2, core.length - (suf ? suf.length : 0))
  }
  return { isGeneric, denominator, suffixes }
}

export function nameFromCaptions(texts, handles, vocab = NO_VOCAB) {
  const cores = [...new Set(handles
    .filter((h) => h && !isBracket(h))
    .map((h) => letters(h.replace(/^@/, '').split('@')[0])))]
    .filter((c) => c.length >= 3)
  if (!cores.length || !texts.length) return null
  const votes = new Map() // lowercased phrase → { score, forms: Map(original → n) }
  for (const text of texts) {
    const seenHere = new Map()
    for (const run of phraseRuns(text)) {
      for (let i = 0; i < run.length; i++) {
        for (let j = i + 1; j <= Math.min(run.length, i + 5); j++) {
          const words = run.slice(i, j)
          const score = Math.max(...cores.map((c) => phraseScore(words, c, vocab)))
          if (!score) continue
          const phrase = words.join(' ')
          const k = phrase.toLowerCase()
          if ((seenHere.get(k) || 0) < score) seenHere.set(k, score)
          if (!votes.has(k)) votes.set(k, { score: 0, forms: new Map() })
          const v = votes.get(k)
          v.forms.set(phrase, (v.forms.get(phrase) || 0) + 1)
        }
      }
    }
    for (const [k, score] of seenHere) votes.get(k).score += score
  }
  let best = null
  for (const [k, v] of votes) {
    if (!best || v.score > best.v.score || (v.score === best.v.score && k.length > best.k.length)) best = { k, v }
  }
  if (!best) return null
  let form = null, n = -1
  for (const [f, c] of best.v.forms) if (c > n) { form = f; n = c }
  return { name: form, score: best.v.score }
}

/* -------------------------------------------------------------- directory */

// posts:    [{ id, text, dueAt, createdAt, channelId }]
// channels: [{ id, service, name }]
// Returns { entities, stats }.
export function buildDirectory(posts, channels, { linkWindowSeconds = 180, dueWindowSeconds = 300 } = {}) {
  const serviceOf = new Map(channels.map((c) => [c.id, c.service]))
  const ownHandles = new Set(channels.map((c) => `@${(c.name || '').toLowerCase()}`))

  // 1. Mentions per post, and per-handle usage stats.
  const nodes = new Map() // key → { key, family, raw variants, count, lastUsed }
  const items = []
  for (const p of posts) {
    const service = serviceOf.get(p.channelId)
    if (!service || !p.text) continue
    const family = familyOf(service)
    const mentions = extractMentions(p.text, service).filter((m) => !ownHandles.has(m.raw.toLowerCase()))
    const when = Date.parse(p.dueAt || p.createdAt) || 0
    for (const m of mentions) {
      let node = nodes.get(m.key)
      if (!node) nodes.set(m.key, node = { key: m.key, family, variants: new Map(), count: 0, lastUsed: 0, posts: 0, texts: [] })
      node.count++
      if (node.texts.length < 25 && !node.texts.includes(p.text)) node.texts.push(p.text)
      node.variants.set(m.raw, (node.variants.get(m.raw) || 0) + 1)
      if (when > node.lastUsed) node.lastUsed = when
    }
    if (mentions.length) {
      items.push({
        post: p,
        family,
        mentions,
        created: Date.parse(p.createdAt) || 0,
        due: Date.parse(p.dueAt) || 0,
        words: new Set(words(p.text)),
      })
    }
  }

  // 2. Cross-posts: the same message sent to several networks at once.
  //    Buffer creates those posts seconds apart, and they share a send time.
  const edges = new Map() // "a|b" → weight
  const addEdge = (a, b, w) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`
    edges.set(k, (edges.get(k) || 0) + w)
  }
  const seenPairs = new Set()
  let crossPosts = 0

  const scanPairs = (field, windowMs) => {
    const sorted = items.filter((i) => i[field]).sort((a, b) => a[field] - b[field])
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j][field] - sorted[i][field] <= windowMs; j++) {
        const A = sorted[i], B = sorted[j]
        if (A.family === B.family) continue
        const pairId = A.post.id < B.post.id ? `${A.post.id}|${B.post.id}` : `${B.post.id}|${A.post.id}`
        if (seenPairs.has(pairId)) continue
        seenPairs.add(pairId)
        if (Math.min(A.words.size, B.words.size) < 4 || overlap(A.words, B.words) < 0.6) continue
        crossPosts++
        for (const [ma, mb] of alignMentions(A, B)) addEdge(ma.key, mb.key, 1)
      }
    }
  }
  scanPairs('created', linkWindowSeconds * 1000)
  scanPairs('due', dueWindowSeconds * 1000)

  // 3. The same readable handle on two networks is weaker evidence, but common.
  const byText = new Map()
  for (const node of nodes.values()) {
    const raw = topVariant(node)
    if (isBracket(raw)) continue
    const t = raw.toLowerCase().replace(/^@/, '').replace(/@.*$/, '')
    if (!byText.has(t)) byText.set(t, [])
    byText.get(t).push(node.key)
  }
  for (const keys of byText.values()) {
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      if (nodes.get(keys[i]).family !== nodes.get(keys[j]).family) addEdge(keys[i], keys[j], 3)
    }
  }

  const vocab = handleVocabulary([...nodes.values()].map((n) => topVariant(n)))

  // 4. Merge, strongest evidence first. An entity holds at most one handle per
  //    network, so a link that would put two Facebook pages on one entity is
  //    refused and kept as a conflict: usually a mis-tag in an old post.
  const parent = new Map([...nodes.keys()].map((k) => [k, k]))
  const fams = new Map([...nodes.values()].map((n) => [n.key, new Set([n.family])]))
  const find = (k) => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k)))
  const conflicts = []
  const sortedEdges = [...edges.entries()]
    .map(([k, w]) => { const [a, b] = k.split('|'); return { a, b, w } })
    .filter((e) => nodes.has(e.a) && nodes.has(e.b))
    .sort((x, y) => y.w - x.w || (nodes.get(y.a).count + nodes.get(y.b).count) - (nodes.get(x.a).count + nodes.get(x.b).count))

  for (const e of sortedEdges) {
    const ra = find(e.a), rb = find(e.b)
    if (ra === rb) continue
    const fa = fams.get(ra), fb = fams.get(rb)
    if ([...fa].some((f) => fb.has(f))) { conflicts.push(e); continue }
    parent.set(rb, ra)
    for (const f of fb) fa.add(f)
  }

  // 5. Shape entities.
  const groups = new Map()
  for (const key of nodes.keys()) {
    const r = find(key)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(nodes.get(key))
  }
  const entityOfKey = new Map()
  const entities = []
  for (const members of groups.values()) {
    const handles = {}, counts = {}, keys = []
    let total = 0, lastUsed = 0
    for (const n of members) {
      handles[n.family] = topVariant(n)
      counts[n.family] = n.count
      keys.push(n.key)
      total += n.count
      lastUsed = Math.max(lastUsed, n.lastUsed)
    }
    const fromCaptions = nameFromCaptions(members.flatMap((n) => n.texts), Object.values(handles), vocab)
    const nameHandle = FAMILY_ORDER.map((f) => handles[f]).find((h) => h && nameFromHandle(h))
    const name = fromCaptions?.name || (nameHandle ? nameFromHandle(nameHandle, vocab) : '')
    const entity = {
      id: stableId(keys),
      name: name || `${FAMILY_LABEL[members[0].family] || members[0].family} account ${shortRaw(handles[members[0].family])}`,
      nameSource: fromCaptions ? 'captions' : name ? 'handle' : 'none',
      needsName: true, // every scanned name is a suggestion until the user confirms it
      unnamed: !name,
      aliases: [],
      handles,
      counts,
      keys,
      total,
      lastUsed: lastUsed ? new Date(lastUsed).toISOString() : null,
      conflicts: [],
      source: 'scan',
    }
    for (const k of keys) entityOfKey.set(k, entity)
    entities.push(entity)
  }
  for (const c of conflicts) {
    if (c.w < 2 && !isBracket(rawOf(nodes, c.a)) && !isBracket(rawOf(nodes, c.b))) continue
    const A = entityOfKey.get(c.a), B = entityOfKey.get(c.b)
    if (!A || !B || A === B) continue
    A.conflicts.push({ withId: B.id, withName: B.name, handle: rawOf(nodes, c.b), times: c.w })
    B.conflicts.push({ withId: A.id, withName: A.name, handle: rawOf(nodes, c.a), times: c.w })
  }
  entities.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))

  return {
    entities,
    stats: {
      posts: posts.length,
      postsWithMentions: items.length,
      handles: nodes.size,
      crossPosts,
      linkedEntities: entities.filter((e) => Object.keys(e.handles).length > 1).length,
      conflicts: entities.filter((e) => e.conflicts.length).length,
    },
  }
}

function topVariant(node) {
  let best = null, n = -1
  for (const [raw, c] of node.variants) if (c > n) { best = raw; n = c }
  return best
}

function rawOf(nodes, key) {
  const n = nodes.get(key)
  return n ? topVariant(n) : key
}

function shortRaw(raw) {
  if (!raw) return ''
  if (isBracket(raw)) {
    const inner = raw.slice(2, raw.indexOf(']'))
    return /^\d+$/.test(inner) ? `…${inner.slice(-4)}` : inner
  }
  return raw
}

function stableId(keys) {
  const s = [...keys].sort()[0]
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return `e${(h >>> 0).toString(36)}`
}

// Pairs the mentions of two versions of one message. Uses the words around
// each mention ("…'s roster looks improved…"), the order they appear in, and an
// identical handle on both sides.
export function alignMentions(A, B) {
  const ta = A.post.text, tb = B.post.text
  const ctx = (text, m) => new Set([...contextWords(text, m, 'before'), ...contextWords(text, m, 'after')])
  const ca = A.mentions.map((m) => ctx(ta, m))
  const cb = B.mentions.map((m) => ctx(tb, m))
  const sameCount = A.mentions.length === B.mentions.length
  const single = A.mentions.length === 1 && B.mentions.length === 1
  const scored = []
  A.mentions.forEach((ma, i) => B.mentions.forEach((mb, j) => {
    let shared = 0
    for (const w of ca[i]) if (cb[j].has(w)) shared++
    let score = shared
    if (sameCount && i === j && !single) score += 1
    if (single) score += 1
    const plainA = ma.raw.toLowerCase().replace(/^@/, ''), plainB = mb.raw.toLowerCase().replace(/^@/, '')
    if (!isBracket(ma.raw) && plainA === plainB) score += 5
    scored.push({ i, j, score })
  }))
  scored.sort((x, y) => y.score - x.score)
  const usedA = new Set(), usedB = new Set(), pairs = []
  for (const s of scored) {
    if (usedA.has(s.i) || usedB.has(s.j)) continue
    if (s.score < 2) continue
    usedA.add(s.i); usedB.add(s.j)
    pairs.push([A.mentions[s.i], B.mentions[s.j]])
  }
  return pairs
}

/* --------------------------------------------------- merge with user edits */

// A rescan must not undo the user's work: names, aliases, hand-edited
// handles and deletions survive, keyed by any handle the two versions share.
export function mergeDirectory(previous, fresh) {
  if (!previous?.length) return fresh
  const prevByKey = new Map()
  for (const e of previous) for (const k of e.keys || []) prevByKey.set(k, e)
  const used = new Set()
  const out = []
  for (const e of fresh) {
    const old = e.keys.map((k) => prevByKey.get(k)).find(Boolean)
    if (!old) { out.push(e); continue }
    if (used.has(old.id)) { out.push(e); continue }
    used.add(old.id)
    if (old.deleted) { out.push({ ...e, id: old.id, deleted: true }); continue }
    out.push({
      ...e,
      id: old.id,
      name: old.userNamed ? old.name : e.name,
      nameSource: old.userNamed ? 'user' : e.nameSource,
      userNamed: Boolean(old.userNamed),
      needsName: old.userNamed ? false : e.needsName,
      unnamed: old.userNamed ? false : e.unnamed,
      aliases: old.aliases || [],
      handles: { ...e.handles, ...(old.editedHandles || {}) },
      editedHandles: old.editedHandles || {},
      keys: [...new Set([...e.keys, ...(old.keys || [])])],
    })
  }
  for (const e of previous) if (!used.has(e.id) && e.source === 'manual') out.push(e)
  return out
}

/* ------------------------------------------------------------- composing */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Builds a matcher for every name and alias in the directory.
export function buildMatcher(entities, { matchCase = false } = {}) {
  const lookup = new Map()
  for (const e of entities) {
    if (e.deleted) continue
    for (const term of [e.name, ...(e.aliases || [])]) {
      const t = (term || '').trim()
      if (t.length < 2) continue
      const k = matchCase ? t : t.toLowerCase()
      if (!lookup.has(k)) lookup.set(k, e)
    }
  }
  const terms = [...lookup.keys()].sort((a, b) => b.length - a.length)
  if (!terms.length) return { find: () => [], lookup }
  const re = new RegExp(`(?<![\\p{L}\\p{N}_@])(${terms.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, matchCase ? 'gu' : 'giu')
  return {
    lookup,
    find(text) {
      const out = []
      for (const m of text.matchAll(re)) {
        const e = lookup.get(matchCase ? m[1] : m[1].toLowerCase())
        if (e) out.push({ index: m.index, end: m.index + m[1].length, text: m[1], entity: e })
      }
      return out
    },
  }
}

// Splits a caption into text and tag parts for one network.
// skip: Set of entity ids the user chose to leave as plain text.
export function renderForService(text, matches, service, skip = new Set()) {
  const family = familyOf(service)
  const parts = []
  let last = 0
  for (const m of matches) {
    if (m.index < last) continue
    parts.push({ text: text.slice(last, m.index) })
    if (skip.has(m.entity.id)) parts.push({ text: m.text })
    else {
      const handle = m.entity.handles[family]
      parts.push(handle
        ? { tag: true, text: handle, label: isBracket(handle) ? m.entity.name : handle, entity: m.entity }
        : { missing: true, text: m.text, entity: m.entity })
    }
    last = m.end
  }
  parts.push({ text: text.slice(last) })
  return {
    parts,
    output: parts.map((p) => p.text).join(''),
  }
}

// Autocomplete: entities whose name, alias or handle starts with the fragment.
export function suggest(entities, fragment, limit = 7) {
  const q = fragment.replace(/^@/, '').toLowerCase()
  if (q.length < 2) return []
  const scored = []
  for (const e of entities) {
    if (e.deleted) continue
    let best = 0
    const consider = (s, weight) => {
      const v = (s || '').toLowerCase().replace(/^@/, '')
      if (!v) return
      if (v.startsWith(q)) best = Math.max(best, weight + 2)
      else if (v.split(/[\s._-]+/).some((w) => w.startsWith(q))) best = Math.max(best, weight + 1)
    }
    consider(e.name, 3)
    for (const a of e.aliases || []) consider(a, 3)
    for (const h of Object.values(e.handles)) if (!isBracket(h)) consider(h, 1)
    if (best) scored.push({ e, score: best * 1000 + Math.min(e.total || 0, 999) })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.e)
}

/* ------------------------------------------------------------ scan plan */

// Month-sized windows, newest first, ending now.
export function monthWindows(months, now = new Date()) {
  const out = []
  let end = new Date(now)
  for (let i = 0; i < months; i++) {
    const start = new Date(end)
    start.setUTCMonth(start.getUTCMonth() - 1)
    out.push({ start: start.toISOString(), end: end.toISOString() })
    end = start
  }
  return out
}

/* ---------------------------------------------------------------- export */

export function toCSV(entities, families) {
  const cols = ['Name', 'Aliases', ...families.map((f) => FAMILY_LABEL[f] || f), 'Times tagged', 'Last tagged']
  const esc = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const rows = entities.filter((e) => !e.deleted).map((e) => [
    e.name,
    (e.aliases || []).join('; '),
    ...families.map((f) => e.handles[f] || ''),
    String(e.total || 0),
    e.lastUsed ? e.lastUsed.slice(0, 10) : '',
  ])
  return [cols, ...rows].map((r) => r.map((v) => esc(String(v))).join(',')).join('\n')
}

import {
  NETWORKS, FAMILY_LABEL, FAMILY_ORDER, familyOf, isBracket,
  buildDirectory, mergeDirectory, buildMatcher, renderForService, suggest, monthWindows, toCSV,
} from './engine.js'

/* ------------------------------------------------------------------ utils */
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmt = (n) => Number(n || 0).toLocaleString()
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { flash('This browser would not save the directory (storage full or blocked). Export a CSV to keep it.') } },
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.body ? 'POST' : 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.error || `Request failed (${res.status})`)
    err.status = res.status
    err.retryAfter = Number(json.retryAfter || res.headers.get('Retry-After')) || 0
    throw err
  }
  return json
}

function flash(msg, ok = false) {
  const el = $('#flash')
  el.textContent = msg
  el.classList.toggle('ok', ok)
  el.hidden = !msg
  if (msg) clearTimeout(flash.t), (flash.t = setTimeout(() => { el.hidden = true }, ok ? 4000 : 12000))
}

/* ------------------------------------------------------------------ state */
const S = {
  account: null,
  orgId: null,
  channels: [],
  dir: null, // { entities, stats, scannedAt, months, channelIds }
  view: 'scan',
  filter: 'all',
  q: '',
  shown: 100,
  skip: new Set(),
  sendTo: new Set(),
  status: {}, // channelId → { ok, msg }
}
const dirKey = () => `hat:dir:${S.orgId}`
const prefKey = () => `hat:prefs:${S.orgId}`
const saveDir = () => { store.set(dirKey(), S.dir); renderCount() }
const entities = () => (S.dir?.entities || []).filter((e) => !e.deleted)

/* ------------------------------------------------------------------- boot */
async function boot() {
  const params = new URLSearchParams(location.search)
  if (params.get('error')) { flash(params.get('error')); history.replaceState(null, '', '/') }

  let session
  try { session = await api('/api/session') } catch (e) { session = { connected: false }; flash(e.message) }
  if (!session.connected) { $('#welcome').hidden = false; return }

  S.account = session.account
  const orgs = S.account.organizations || []
  $('#org').innerHTML = orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')
  $('#org').closest('.org').hidden = orgs.length < 2
  $('#who').textContent = S.account.email || S.account.name || ''
  $('#account').hidden = false
  $('#app').hidden = false
  S.orgId = store.get('hat:org', null)
  if (!orgs.some((o) => o.id === S.orgId)) S.orgId = orgs[0]?.id
  $('#org').value = S.orgId
  await loadOrg()
}

async function loadOrg() {
  store.set('hat:org', S.orgId)
  S.dir = store.get(dirKey(), null)
  S.skip.clear(); S.status = {}
  $('#scan-channels').innerHTML = '<p class="muted small">Loading channels…</p>'
  try {
    S.channels = (await api(`/api/channels?organizationId=${encodeURIComponent(S.orgId)}`)).channels
  } catch (e) {
    S.channels = []
    flash(e.message)
  }
  const prefs = store.get(prefKey(), {})
  S.sendTo = new Set((prefs.sendTo || S.channels.map((c) => c.id)).filter((id) => S.channels.some((c) => c.id === id)))
  renderChannels()
  renderLastScan()
  renderCount()
  show(S.dir?.entities?.length ? 'compose' : 'scan')
}

/* ------------------------------------------------------------------ views */
function show(view) {
  S.view = view
  for (const b of $$('.steps button')) b.setAttribute('aria-selected', String(b.dataset.view === view))
  for (const v of ['scan', 'directory', 'compose']) $(`#view-${v}`).hidden = v !== view
  if (view === 'directory') renderDirectory()
  if (view === 'compose') { renderPickChannels(); renderCompose() }
}
function renderCount() {
  const n = entities().length
  $('#dir-count').textContent = n ? fmt(n) : ''
}

function channelLabel(c) { return c.displayName || c.name }
function netBadge(service) {
  const f = familyOf(service)
  return `<span class="net ${esc(f)}">${esc(NETWORKS[service]?.label || service)}</span>`
}
function avatar(c) { return c.avatar ? `<img src="${esc(c.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<img alt="">' }

/* ------------------------------------------------------------------- scan */
function renderChannels() {
  const prev = new Set(S.dir?.channelIds || S.channels.map((c) => c.id))
  $('#scan-channels').innerHTML = S.channels.length
    ? S.channels.map((c) => `
      <label class="ch">${avatar(c)}<span class="t"><b>${esc(channelLabel(c))}</b>${netBadge(c.service)}</span>
        <input type="checkbox" value="${esc(c.id)}" ${prev.has(c.id) ? 'checked' : ''}></label>`).join('')
    : '<p class="muted">No connected channels in this organization.</p>'
}

function renderLastScan() {
  const d = S.dir
  $('#last-scan').textContent = d?.scannedAt
    ? `Last scan ${new Date(d.scannedAt).toLocaleString()} · ${d.months} months · ${fmt(d.stats?.posts)} posts · ${fmt(entities().length)} accounts`
    : ''
}

let scanning = null
async function startScan() {
  const channelIds = $$('#scan-channels input:checked').map((i) => i.value)
  if (!channelIds.length) return flash('Pick at least one channel to scan.')
  const months = Number($('#scan-months').value)
  const run = scanning = { stop: false }
  $('#scan-start').disabled = true
  $('#scan-stop').hidden = false
  $('#scan-progress').hidden = false
  flash('')

  const posts = []
  const seen = new Set()
  let requests = 0
  let batchSize = 4
  const windows = monthWindows(months)
  const queue = windows.map((w, i) => ({ ...w, month: i, channelIds, after: null }))
  const doneMonths = new Set()
  const pages = new Map(windows.map((_, i) => [i, 0]))
  const skipped = []

  const status = (t) => { $('#scan-status').textContent = t }
  const tick = () => {
    $('#p-posts').textContent = fmt(posts.length)
    $('#p-req').textContent = fmt(requests)
    $('#scan-bar').style.width = `${Math.round((doneMonths.size / windows.length) * 100)}%`
  }
  let liveHandles = new Set()
  const countHandles = () => {
    // cheap running count for the ticker; the real merge runs at the end
    const re = /@\[[^\]]+\]|@[A-Za-z0-9_.]{2,30}/g
    for (const p of posts.slice(countHandles.n || 0)) for (const m of (p.text || '').match(re) || []) liveHandles.add(m.toLowerCase())
    countHandles.n = posts.length
    $('#p-handles').textContent = fmt(liveHandles.size)
  }

  try {
    while (queue.length && !run.stop) {
      const batch = queue.splice(0, batchSize)
      status(`Reading ${describeBatch(batch)}…`)
      let res
      try {
        res = await api('/api/history', {
          body: {
            organizationId: S.orgId,
            windows: batch.map(({ channelIds: c, start, end, after }) => ({ channelIds: c, start, end, after })),
          },
        })
        requests++
      } catch (e) {
        requests++
        if (e.status === 401) { flash('Your Buffer connection expired. Connect again to continue.'); break }
        if (e.status === 429) {
          queue.unshift(...batch)
          const wait = e.retryAfter || 60
          if (wait > 180) {
            status(`Buffer's request limit for this app is used up for now. It resets in about ${Math.ceil(wait / 60)} minutes. What was read so far has been saved.`)
            break
          }
          for (let s = wait; s > 0 && !run.stop; s--) { status(`Pausing for Buffer's rate limit… resuming in ${s}s`); await sleep(1000) }
          continue
        }
        // Too much in one go (a busy month across many channels): split it up.
        if (batch.length > 1) { batchSize = Math.max(1, Math.floor(batch.length / 2)); queue.unshift(...batch); continue }
        const w = batch[0]
        if (w.channelIds.length > 1 && !w.after) {
          queue.unshift(...w.channelIds.map((id) => ({ ...w, channelIds: [id] })))
          continue
        }
        skipped.push(w)
        if (!queue.some((q) => q.month === w.month)) doneMonths.add(w.month)
        tick()
        continue
      }
      if (res.rateLimit) {
        const r = /(?:^|[;,\s])r=(\d+)/.exec(res.rateLimit)
        if (r) $('#p-quota').textContent = `${r[1]} requests left in this window`
      }
      res.results.forEach((r, i) => {
        const w = batch[i]
        for (const p of r.posts) if (!seen.has(p.id)) { seen.add(p.id); posts.push(p) }
        pages.set(w.month, pages.get(w.month) + 1)
        if (r.hasNextPage && r.endCursor && pages.get(w.month) < 60) queue.push({ ...w, after: r.endCursor })
        else if (!queue.some((q) => q.month === w.month) && !batch.slice(i + 1).some((b) => b.month === w.month)) doneMonths.add(w.month)
      })
      tick(); countHandles()
    }
  } finally {
    $('#scan-start').disabled = false
    $('#scan-stop').hidden = true
    scanning = null
  }

  if (!posts.length) {
    status(run.stop ? 'Scan stopped.' : skipped.length ? 'Buffer could not return those posts. Try fewer channels or a shorter range.' : 'No sent posts found in that range.')
    return
  }
  const scanned = S.channels.filter((c) => channelIds.includes(c.id))
  const fresh = buildDirectory(posts, scanned)
  const merged = mergeDirectory(S.dir?.entities, fresh.entities)
  S.dir = { entities: merged, stats: fresh.stats, scannedAt: new Date().toISOString(), months, channelIds }
  saveDir()
  renderLastScan()
  $('#scan-bar').style.width = '100%'
  const partial = run.stop || queue.length ? ' (partial scan)' : ''
  status(`Done${partial}. ${fmt(fresh.stats.handles)} handles from ${fmt(posts.length)} posts, grouped into ${fmt(merged.filter((e) => !e.deleted).length)} accounts.${skipped.length ? ` ${skipped.length} month(s) could not be read.` : ''}`)
  flash(`Directory ready: ${fmt(fresh.stats.linkedEntities)} accounts matched across networks.`, true)
  show('directory')
}

function describeBatch(batch) {
  const fmtM = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  const months = [...new Set(batch.map((w) => fmtM(w.start)))]
  return months.length > 2 ? `${months[months.length - 1]} – ${months[0]}` : months.join(', ')
}

/* -------------------------------------------------------------- directory */
function families() {
  const have = new Set()
  for (const e of entities()) for (const f of Object.keys(e.handles)) have.add(f)
  for (const c of S.channels) have.add(familyOf(c.service))
  return FAMILY_ORDER.filter((f) => have.has(f))
}

function filtered() {
  const q = S.q.trim().toLowerCase()
  return entities().filter((e) => {
    if (S.filter === 'linked' && Object.keys(e.handles).length < 2) return false
    if (S.filter === 'unnamed' && !e.unnamed) return false
    if (S.filter === 'conflicts' && !e.conflicts?.length) return false
    if (!q) return true
    return [e.name, ...(e.aliases || []), ...Object.values(e.handles)].some((v) => (v || '').toLowerCase().includes(q))
  })
}

function renderDirectory() {
  const st = S.dir?.stats
  const all = entities()
  $('#dir-stats').innerHTML = st ? [
    [fmt(st.posts), 'posts scanned'],
    [fmt(all.length), 'accounts in your directory'],
    [fmt(all.filter((e) => Object.keys(e.handles).length > 1).length), 'matched across networks'],
    [fmt(all.filter((e) => e.conflicts?.length).length), 'possible mis-tags', 'warn'],
  ].map(([n, l, c]) => `<div class="stat ${c || ''}"><b>${n}</b><span>${l}</span></div>`).join('') : ''

  const fams = families()
  $('#dir-head').innerHTML = `<tr><th>Name</th><th>Aliases</th>${fams.map((f) => `<th>${esc(FAMILY_LABEL[f] || f)}</th>`).join('')}<th class="num">Tagged</th><th></th></tr>`
  const list = filtered()
  $('#dir-rows').innerHTML = list.slice(0, S.shown).map((e) => `
    <tr data-id="${esc(e.id)}" class="${e.needsName ? 'suggested' : ''}">
      <td class="name"><input value="${esc(e.name)}" data-k="name" aria-label="Name" title="${e.needsName ? 'Suggested from the handle. Edit to confirm.' : ''}">${e.unnamed ? '<span class="badge new">needs a name</span>' : ''}${conflictBadge(e)}</td>
      <td class="al"><input value="${esc((e.aliases || []).join(', '))}" data-k="aliases" placeholder="add aliases" aria-label="Aliases"></td>
      ${fams.map((f) => `<td class="h">${e.handles[f] ? esc(displayHandle(e.handles[f])) : '<span class="none">—</span>'}</td>`).join('')}
      <td class="num" title="${e.lastUsed ? 'Last tagged ' + new Date(e.lastUsed).toLocaleDateString() : ''}">${fmt(e.total || 0)}</td>
      <td class="row-actions"><button class="icon-btn" data-act="edit" type="button" title="Edit handles">Edit</button><button class="icon-btn" data-act="del" type="button" title="Remove from directory">✕</button></td>
    </tr>`).join('')
  $('#dir-more').hidden = list.length <= S.shown
  $('#dir-more').textContent = `Show more (${fmt(list.length - S.shown)} left)`
  $('#dir-empty').hidden = all.length > 0
}

function displayHandle(h) {
  if (!isBracket(h)) return h
  const inner = h.slice(2, h.indexOf(']'))
  return /^\d+$/.test(inner) ? `page …${inner.slice(-6)}` : inner
}

function conflictBadge(e) {
  if (!e.conflicts?.length) return ''
  const t = e.conflicts.map((c) => `Also paired with ${displayHandle(c.handle)} (${c.times}×), which is filed under “${c.withName}”`).join('\n')
  return `<span class="badge warn" title="${esc(t + '\nAn old post may have tagged the wrong account.')}">check</span>`
}

function onDirInput(ev) {
  const input = ev.target.closest('input[data-k]')
  if (!input) return
  const e = S.dir.entities.find((x) => x.id === input.closest('tr').dataset.id)
  if (!e) return
  if (input.dataset.k === 'name') {
    const v = input.value.trim()
    if (!v) return
    e.name = v; e.needsName = false; e.unnamed = false
    input.closest('tr').classList.remove('suggested')
  } else {
    e.aliases = input.value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  saveDir()
}

function onDirClick(ev) {
  const b = ev.target.closest('button[data-act]')
  if (!b) return
  const e = S.dir.entities.find((x) => x.id === b.closest('tr').dataset.id)
  if (!e) return
  if (b.dataset.act === 'del') {
    e.deleted = true
    saveDir(); renderDirectory()
    flash(`Removed ${e.name}. A rescan won't bring it back.`, true)
  } else openEditor(e)
}

function openEditor(e = null) {
  const fams = families()
  const dlg = $('#edit-dialog'), form = $('#edit-form')
  $('#edit-title').textContent = e ? `Edit ${e.name}` : 'Add account'
  form.name.value = e?.name || ''
  form.aliases.value = (e?.aliases || []).join(', ')
  $('#edit-handles').innerHTML = fams.map((f) => `<label>${esc(FAMILY_LABEL[f] || f)}<input data-f="${esc(f)}" value="${esc(e?.handles[f] || '')}" placeholder="${f === 'facebook' ? '@[page id] or @PageName' : '@handle'}"></label>`).join('')
  dlg.showModal()
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') return
    const name = form.name.value.trim()
    if (!name) return
    const handles = {}
    for (const i of $$('#edit-handles input')) {
      let v = i.value.trim()
      if (!v) continue
      if (!v.startsWith('@')) v = '@' + v
      handles[i.dataset.f] = v
    }
    const aliases = form.aliases.value.split(',').map((s) => s.trim()).filter(Boolean)
    if (!S.dir) S.dir = { entities: [], stats: null, scannedAt: null, months: 0, channelIds: [] }
    if (e) {
      const edited = { ...(e.editedHandles || {}) }
      for (const f of fams) if ((handles[f] || '') !== (e.handles[f] || '')) edited[f] = handles[f]
      Object.assign(e, { name, aliases, handles, editedHandles: edited, needsName: false, unnamed: false })
    } else {
      S.dir.entities.unshift({ id: `m${Date.now().toString(36)}`, name, aliases, handles, editedHandles: handles, counts: {}, keys: [], total: 0, lastUsed: null, conflicts: [], source: 'manual', needsName: false })
    }
    saveDir(); renderDirectory()
  }
}

function exportCSV() {
  const blob = new Blob([toCSV(entities(), families())], { type: 'text/csv' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'handle-directory.csv' })
  a.click(); URL.revokeObjectURL(a.href)
}

/* ---------------------------------------------------------------- compose */
let matcher = null
let matcherFor = null
function getMatcher() {
  const key = `${S.dir?.scannedAt}|${entities().length}|${$('#match-case').checked}|${entities().map((e) => e.name + (e.aliases || []).join()).join('|').length}`
  if (matcherFor !== key) { matcher = buildMatcher(entities(), { matchCase: $('#match-case').checked }); matcherFor = key }
  return matcher
}

function renderPickChannels() {
  $('#pick-channels').innerHTML = S.channels.map((c) => `
    <button type="button" class="chip ${S.sendTo.has(c.id) ? 'on' : ''}" data-ch="${esc(c.id)}" title="${esc(channelLabel(c))}">${netBadge(c.service)} ${esc(shortName(c))}</button>`).join('')
}
function shortName(c) { const n = channelLabel(c); return n.length > 16 ? n.slice(0, 15) + '…' : n }

function renderCompose() {
  const text = $('#caption').value
  const matches = text ? getMatcher().find(text) : []

  // tagged chips
  const found = new Map()
  for (const m of matches) found.set(m.entity.id, m.entity)
  $('#tagged').innerHTML = found.size
    ? '<span class="lbl">Tagged</span>' + [...found.values()].map((e) => `<button type="button" class="chip ${S.skip.has(e.id) ? 'off' : ''}" data-ent="${esc(e.id)}" title="${S.skip.has(e.id) ? 'Click to tag again' : 'Click to leave as plain text'}">${esc(e.name)} <span class="x">${S.skip.has(e.id) ? 'untagged' : '×'}</span></button>`).join('')
    : ''

  const chans = S.channels.filter((c) => S.sendTo.has(c.id))
  $('#outs').innerHTML = chans.length ? chans.map((c) => {
    const r = renderForService(text, matches, c.service, S.skip)
    const html = text
      ? r.parts.map((p) => p.tag ? `<span class="tagtxt" title="${esc(p.entity.name)}${isBracket(p.text) ? ' · sends as ' + esc(p.text) : ''}">${esc(p.label)}</span>`
        : p.missing ? `<span class="miss" title="No ${esc(NETWORKS[c.service]?.label || c.service)} handle on file for ${esc(p.entity.name)}. Edit it in the directory.">${esc(p.text)}</span>`
          : esc(p.text)).join('')
      : '<span class="ph">Your caption appears here.</span>'
    const n = [...r.output].length
    const lim = NETWORKS[c.service]?.limit
    const missing = r.parts.filter((p) => p.missing).length
    const st = S.status[c.id]
    return `<article class="out">
      <div class="out-h"><span class="who-ch">${avatar(c)}<b>${esc(channelLabel(c))}</b>${netBadge(c.service)}</span>
        <button class="btn ghost tiny" data-copy="${esc(c.id)}" type="button">Copy</button></div>
      <div class="out-text">${html}</div>
      <div class="out-f"><span>${st ? `<span class="${st.ok ? 'st-ok' : 'st-err'}">${esc(st.msg)}</span>` : missing ? `<span>${missing} name${missing > 1 ? 's' : ''} without a handle here</span>` : ''}</span>
        <span class="${lim && n > lim ? 'over' : ''}">${fmt(n)}${lim ? ' / ' + fmt(lim) : ''}</span></div>
    </article>`
  }).join('') : '<p class="muted">Pick at least one channel above.</p>'

  const when = $('input[name=when]:checked').value
  $('#due').hidden = when !== 'schedule'
  $('#send').disabled = !text.trim() || !chans.length || sending
  $('#send').textContent = sending ? 'Sending…' : when === 'draft' ? `Save ${chans.length} draft${chans.length === 1 ? '' : 's'}` : `Send to ${chans.length} channel${chans.length === 1 ? '' : 's'}`
  $('#send-summary').textContent = found.size ? `${found.size} account${found.size === 1 ? '' : 's'} tagged` : ''
}

function outputFor(c) {
  const text = $('#caption').value
  return renderForService(text, getMatcher().find(text), c.service, S.skip).output
}

let sending = false
async function send() {
  const when = $('input[name=when]:checked').value
  let dueAt = null
  if (when === 'schedule') {
    const v = $('#due').value
    if (!v) return flash('Pick a date and time to schedule.')
    dueAt = new Date(v).toISOString() // datetime-local is local time; convert with the browser's offset
  }
  const media = $('#media').value.trim()
  const chans = S.channels.filter((c) => S.sendTo.has(c.id))
  sending = true; S.status = {}; renderCompose()
  let ok = 0
  for (const c of chans) {
    S.status[c.id] = { ok: true, msg: 'Sending…' }; renderCompose()
    try {
      await api('/api/posts', { body: { organizationId: S.orgId, channelId: c.id, text: outputFor(c), mediaUrl: media || undefined, when, dueAt } })
      S.status[c.id] = { ok: true, msg: when === 'draft' ? '✓ Saved as draft' : when === 'schedule' ? '✓ Scheduled' : '✓ Added to queue' }
      ok++
    } catch (e) {
      S.status[c.id] = { ok: false, msg: e.message }
    }
    renderCompose()
  }
  sending = false; renderCompose()
  if (ok === chans.length) flash(`Sent to ${ok} channel${ok === 1 ? '' : 's'} in Buffer.`, true)
  else flash(`${ok} of ${chans.length} went through. Check the red notes under each version.`)
}

/* ------------------------------------------------------------ autocomplete */
const ac = { items: [], index: 0, start: 0 }
function fragmentAtCaret(ta) {
  const pos = ta.selectionStart
  if (pos !== ta.selectionEnd) return null
  const before = ta.value.slice(0, pos)
  const m = /(?:^|[\s(“"'])(@?[\p{L}\p{N}][\p{L}\p{N}&.'’_-]*(?: [\p{L}\p{N}&.'’_-]+){0,2})$/u.exec(before)
  if (!m) return null
  // try the longest tail first ("Ole Mi" before "Mi")
  const full = m[1]
  const parts = full.split(' ')
  for (let i = 0; i < parts.length; i++) {
    const frag = parts.slice(i).join(' ')
    const items = suggest(entities(), frag)
    if (items.length && (frag.startsWith('@') || frag.length >= 2)) return { frag, start: pos - frag.length, items }
  }
  return null
}

function updateSuggest() {
  const ta = $('#caption'), box = $('#suggest')
  const hit = fragmentAtCaret(ta)
  // don't nag once the fragment is already an exact, matched name
  if (!hit || hit.items.some((e) => e.name.toLowerCase() === hit.frag.toLowerCase())) { box.hidden = true; ac.items = []; return }
  ac.items = hit.items; ac.index = 0; ac.start = hit.start
  box.innerHTML = hit.items.map((e, i) => {
    const hs = FAMILY_ORDER.filter((f) => e.handles[f]).slice(0, 3).map((f) => displayHandle(e.handles[f])).join(' · ')
    return `<li role="option" data-i="${i}" aria-selected="${i === 0}"><b>${esc(e.name)}</b><span>${esc(hs)}</span></li>`
  }).join('')
  const { top, left } = caretXY(ta, hit.start)
  box.style.top = `${top}px`
  box.style.left = `${Math.min(left, ta.clientWidth - 270)}px`
  box.hidden = false
}

function accept(i = ac.index) {
  const e = ac.items[i]
  if (!e) return
  const ta = $('#caption')
  const end = ta.selectionStart
  const insert = e.name + (/^\s/.test(ta.value.slice(end)) ? '' : ' ')
  ta.setRangeText(insert, ac.start, end, 'end')
  S.skip.delete(e.id)
  $('#suggest').hidden = true; ac.items = []
  ta.focus()
  renderCompose()
}

// Caret pixel position via a mirror element with the textarea's text metrics.
function caretXY(ta, index) {
  const div = document.createElement('div')
  const cs = getComputedStyle(ta)
  for (const p of ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'whiteSpace', 'wordWrap', 'tabSize']) div.style[p] = cs[p]
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', top: 0, left: '-9999px' })
  div.textContent = ta.value.slice(0, index)
  const span = document.createElement('span')
  span.textContent = '​'
  div.appendChild(span)
  document.body.appendChild(div)
  const top = span.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight || '24') + 4
  const left = span.offsetLeft
  div.remove()
  return { top, left }
}

/* ------------------------------------------------------------------ wire */
function wire() {
  $('.steps').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) show(b.dataset.view) })
  $('#org').addEventListener('change', (e) => { S.orgId = e.target.value; loadOrg() })
  $('#logout').addEventListener('click', async () => { await api('/auth/logout', { body: {} }).catch(() => {}); location.href = '/' })

  $('#scan-start').addEventListener('click', startScan)
  $('#scan-stop').addEventListener('click', () => { if (scanning) scanning.stop = true })

  $('#dir-rows').addEventListener('change', onDirInput)
  $('#dir-rows').addEventListener('click', onDirClick)
  $('#dir-q').addEventListener('input', (e) => { S.q = e.target.value; S.shown = 100; renderDirectory() })
  $('#dir-filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return
    S.filter = b.dataset.f; S.shown = 100
    for (const c of $$('#dir-filters .chip')) c.classList.toggle('on', c === b)
    renderDirectory()
  })
  $('#dir-more').addEventListener('click', () => { S.shown += 200; renderDirectory() })
  $('#dir-add').addEventListener('click', () => openEditor())
  $('#dir-export').addEventListener('click', exportCSV)

  const ta = $('#caption')
  ta.value = store.get('hat:draft', '')
  ta.addEventListener('input', () => { store.set('hat:draft', ta.value); renderCompose(); updateSuggest() })
  ta.addEventListener('click', updateSuggest)
  ta.addEventListener('blur', () => setTimeout(() => { $('#suggest').hidden = true }, 150))
  ta.addEventListener('keydown', (e) => {
    if ($('#suggest').hidden || !ac.items.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length
      $$('#suggest li').forEach((li, i) => li.setAttribute('aria-selected', String(i === ac.index)))
    } else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept() }
    else if (e.key === 'Escape') { $('#suggest').hidden = true; ac.items = [] }
  })
  $('#suggest').addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); accept(Number(li.dataset.i)) } })
  $('#tagged').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ent]'); if (!b) return
    S.skip.has(b.dataset.ent) ? S.skip.delete(b.dataset.ent) : S.skip.add(b.dataset.ent)
    renderCompose()
  })
  $('#match-case').addEventListener('change', renderCompose)
  $$('input[name=when]').forEach((r) => r.addEventListener('change', renderCompose))
  $('#pick-channels').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch]'); if (!b) return
    S.sendTo.has(b.dataset.ch) ? S.sendTo.delete(b.dataset.ch) : S.sendTo.add(b.dataset.ch)
    store.set(prefKey(), { sendTo: [...S.sendTo] })
    renderPickChannels(); renderCompose()
  })
  $('#outs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]'); if (!b) return
    const c = S.channels.find((x) => x.id === b.dataset.copy)
    try { await navigator.clipboard.writeText(outputFor(c)); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy' }, 1200) } catch { flash('Copy was blocked by the browser.') }
  })
  $('#send').addEventListener('click', send)
}

wire()
boot()

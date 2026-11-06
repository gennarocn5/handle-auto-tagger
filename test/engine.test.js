import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractMentions, buildDirectory, buildMatcher, renderForService, suggest, nameFromHandle, mergeDirectory, monthWindows, toCSV,
} from '../public/engine.js'

const channels = [
  { id: 'x1', service: 'twitter', name: 'd1baseball' },
  { id: 'fb', service: 'facebook', name: 'D1Baseball.com' },
  { id: 'ig', service: 'instagram', name: 'd1baseball' },
  { id: 'th', service: 'threads', name: 'd1baseball' },
]

// Shapes taken from real cross-posted captions: X gets a headline + handle,
// Facebook gets the page id, Instagram is published separately.
const posts = [
  { id: 'a1', channelId: 'x1', createdAt: '2025-11-30T14:02:01.046Z', dueAt: '2025-11-30T14:02:01Z',
    text: '🆕 2025 Fall Report: South Alabama\n\n@SouthAlabamaBSB’s roster looks improved this fall, and the Jaguars hope to return to their winning ways in the Sun Belt. \nhttps://d1ba.se/48jTduF' },
  { id: 'a2', channelId: 'fb', createdAt: '2025-11-30T14:02:05.595Z', dueAt: '2025-11-30T14:02:05Z',
    text: '@[111111111111111]’s roster looks improved this fall, and the Jaguars hope to return to their winning ways in the Sun Belt.' },
  { id: 'b1', channelId: 'x1', createdAt: '2025-11-28T16:19:48.502Z', dueAt: '2025-11-28T16:19:48Z',
    text: '🆕 2025 Fall Report: Kansas\n\nAfter making a regional for the first time in 11 years, @KUBaseball reloaded to build another strong roster around a pair of returning stars. \nhttps://d1ba.se/3MrPBxS' },
  { id: 'b2', channelId: 'fb', createdAt: '2025-11-28T16:19:52.983Z', dueAt: '2025-11-28T16:19:53Z',
    text: 'After making a regional for the first time in 11 years, @[71601871618] reloaded to build another strong roster around a pair of returning stars.' },
  { id: 'b3', channelId: 'ig', createdAt: '2025-11-28T16:20:10Z', dueAt: '2025-11-28T16:20:10Z',
    text: 'After making a regional for the first time in 11 years, @kubaseball reloaded to build another strong roster around a pair of returning stars.\n\n🤝 @kinatraxinc' },
  // Two-team post, opposite order on each network
  { id: 'c1', channelId: 'x1', createdAt: '2025-04-10T12:00:00Z', dueAt: '2025-04-10T18:00:00Z',
    text: 'Big series tonight: @LSUBaseball heads to Oxford to face @OleMissBSB in a top-10 SEC showdown. Preview below.' },
  { id: 'c2', channelId: 'th', createdAt: '2025-04-10T12:00:02Z', dueAt: '2025-04-10T18:00:00Z',
    text: 'Big series tonight: @olemissbsb hosts @lsubaseball in a top-10 SEC showdown in Oxford. Preview below.' },
  // Unrelated post at the same time must not link
  { id: 'd1', channelId: 'fb', createdAt: '2025-04-10T12:00:03Z', dueAt: '2025-04-10T18:00:00Z',
    text: 'Congrats to @[999] on the win, a huge night for the program and the fans in Gainesville.' },
  // emails and URLs are not mentions
  { id: 'e1', channelId: 'x1', createdAt: '2025-03-01T12:00:00Z', dueAt: '2025-03-01T12:00:00Z',
    text: 'Email tips@d1baseball.com or read https://medium.com/@writer — h/t @KUBaseball' },
]

test('extracts handles per network and skips emails and URLs', () => {
  assert.deepEqual(extractMentions(posts[8].text, 'twitter').map((m) => m.raw), ['@KUBaseball'])
  assert.deepEqual(extractMentions('Go @fiu.baseball.', 'instagram').map((m) => m.raw), ['@fiu.baseball'])
  assert.deepEqual(extractMentions('Go @fiu.baseball.', 'twitter').map((m) => m.raw), ['@fiu'])
  assert.deepEqual(extractMentions('@[349941218525211]’s roster', 'facebook').map((m) => m.raw), ['@[349941218525211]'])
  assert.deepEqual(extractMentions('hi @jay.bsky.social!', 'bluesky').map((m) => m.raw), ['@jay.bsky.social'])
})

test('links one account across networks from cross-posts', () => {
  const { entities, stats } = buildDirectory(posts, channels)
  const ku = entities.find((e) => e.handles.x === '@KUBaseball')
  assert.ok(ku, 'Kansas entity exists')
  assert.equal(ku.handles.facebook, '@[71601871618]')
  assert.equal(ku.handles.instagram, '@kubaseball')
  assert.equal(ku.name, 'KU Baseball')

  const usa = entities.find((e) => e.handles.x === '@SouthAlabamaBSB')
  assert.equal(usa.handles.facebook, '@[111111111111111]')
  assert.equal(usa.name, 'South Alabama BSB')

  const lsu = entities.find((e) => e.handles.x === '@LSUBaseball')
  const om = entities.find((e) => e.handles.x === '@OleMissBSB')
  assert.equal(lsu.handles.threads, '@lsubaseball', 'aligned by context, not order')
  assert.equal(om.handles.threads, '@olemissbsb')

  const other = entities.find((e) => e.handles.facebook === '@[999]')
  assert.equal(Object.keys(other.handles).length, 1, 'unrelated post not linked')
  assert.ok(other.unnamed)
  assert.ok(stats.crossPosts >= 3)
})

test('flags a page tagged for two different accounts', () => {
  const extra = [
    { id: 'f1', channelId: 'x1', createdAt: '2025-05-01T12:00:00Z', dueAt: '2025-05-01T12:00:00Z', text: 'Huge win for @GatorsBB tonight in a wild extra-innings game at home.' },
    { id: 'f2', channelId: 'fb', createdAt: '2025-05-01T12:00:04Z', dueAt: '2025-05-01T12:00:04Z', text: 'Huge win for @[111111111111111] tonight in a wild extra-innings game at home.' },
    { id: 'g1', channelId: 'x1', createdAt: '2025-05-02T12:00:00Z', dueAt: '2025-05-02T12:00:00Z', text: 'Another big one for @GatorsBB as the bats stay hot through the weekend series.' },
    { id: 'g2', channelId: 'fb', createdAt: '2025-05-02T12:00:04Z', dueAt: '2025-05-02T12:00:04Z', text: 'Another big one for @[111111111111111] as the bats stay hot through the weekend series.' },
  ]
  const { entities, stats } = buildDirectory([...posts, ...extra], channels)
  const gators = entities.find((e) => e.handles.x === '@GatorsBB')
  const usa = entities.find((e) => e.handles.x === '@SouthAlabamaBSB')
  assert.equal(gators.handles.facebook, '@[111111111111111]', 'stronger evidence wins')
  assert.equal(usa.handles.facebook, undefined)
  assert.equal(usa.conflicts.length, 1, 'the odd pairing is flagged')
  assert.equal(stats.conflicts, 2)
})

test('composer finds names and renders per network', () => {
  const { entities } = buildDirectory(posts, channels)
  const lsu = entities.find((e) => e.handles.x === '@LSUBaseball')
  lsu.name = 'LSU'
  const ku = entities.find((e) => e.handles.x === '@KUBaseball')
  ku.name = 'Kansas'
  ku.aliases = ['KU', 'Jayhawks']
  const m = buildMatcher(entities)
  const text = 'LSU at Kansas tonight. Jayhawks favored.'
  const matches = m.find(text)
  assert.equal(matches.length, 3)
  assert.equal(renderForService(text, matches, 'twitter').output, '@LSUBaseball at @KUBaseball tonight. @KUBaseball favored.')
  const fb = renderForService(text, matches, 'facebook')
  assert.equal(fb.output, 'LSU at @[71601871618] tonight. @[71601871618] favored.')
  assert.ok(fb.parts.some((p) => p.missing && p.text === 'LSU'))
  assert.equal(renderForService(text, matches, 'twitter', new Set([lsu.id])).output, 'LSU at @KUBaseball tonight. @KUBaseball favored.')
})

test('autocomplete matches names, aliases and handles', () => {
  const { entities } = buildDirectory(posts, channels)
  assert.equal(suggest(entities, 'ole')[0].handles.x, '@OleMissBSB')
  assert.equal(suggest(entities, '@kub')[0].handles.x, '@KUBaseball')
  assert.equal(suggest(entities, 'k').length, 0)
})

test('rescans keep user edits', () => {
  const first = buildDirectory(posts, channels).entities
  const ku = first.find((e) => e.handles.x === '@KUBaseball')
  ku.name = 'Kansas'; ku.needsName = false; ku.aliases = ['KU']
  const merged = mergeDirectory(first, buildDirectory(posts, channels).entities)
  const again = merged.find((e) => e.handles.x === '@KUBaseball')
  assert.equal(again.name, 'Kansas')
  assert.deepEqual(again.aliases, ['KU'])
})

test('helpers', () => {
  assert.equal(nameFromHandle('@UCF_Baseball'), 'UCF Baseball')
  assert.equal(nameFromHandle('@ucdavisbaseball'), 'Ucdavisbaseball')
  assert.equal(nameFromHandle('@[71601871618]'), '')
  assert.equal(monthWindows(12).length, 12)
  const csv = toCSV(buildDirectory(posts, channels).entities, ['x', 'facebook'])
  assert.match(csv.split('\n')[0], /^Name,Aliases,X,Facebook/)
})

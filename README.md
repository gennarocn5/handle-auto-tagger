# Handle Auto-Tagger for Buffer

**Type the name. Get the right @ on every network.**

Social teams tag the same accounts over and over, and every network spells them differently: `@OleMissBSB` on X, `@olemissbsb` on Instagram, a numeric page ID on Facebook. Handle Auto-Tagger learns those from the posts you have already sent through Buffer, so you never look one up again.

Live: https://handle-auto-tagger.vercel.app · Built for [Buffer Commit 2026](https://buffer.com/api/commit)

## How it works

1. **Connect Buffer** (OAuth 2.0 + PKCE).
2. **Scan.** Reads up to 12 months of sent posts across the channels you pick. To respect the shared app rate limit, each request asks for several month-long windows at once using GraphQL aliases, so a year of history takes a handful of requests instead of hundreds.
3. **Match.** Every @mention is extracted with that network's handle rules (X, Instagram, Threads, TikTok, Bluesky, Mastodon, plus Facebook's `@[page id]` form). When the same message went to several networks at once, the app lines up the captions word by word to learn which handles belong to the same account. Evidence is merged strongest-first; an account can only have one handle per network, so contradictory pairings are kept aside and flagged as **possible mis-tags** in old posts.
4. **Review.** An editable directory: rename to what you actually type, add aliases (*Ole Miss, Rebels*), fix or add handles. Rescans keep your edits.
5. **Compose.** Write once with plain names, with autocomplete from your directory. See each channel's version with the right handles and character counts, then add it to your queue, schedule it, or save drafts in Buffer.

## Privacy

Tokens live only in an encrypted HTTP-only cookie. Post text passes through the server without being stored, and the directory lives in your browser (export to CSV anytime). No database, no analytics. See [/privacy](https://handle-auto-tagger.vercel.app/privacy).

## Run it yourself

```bash
npm install
npm test            # engine tests (extraction, cross-network linking, conflicts, composer)
```

Deploy to Vercel with three environment variables:

| Variable | Value |
| --- | --- |
| `BUFFER_CLIENT_ID` | From your app client at publish.buffer.com/settings/api |
| `BUFFER_CLIENT_SECRET` | Same place (confidential client) |
| `SESSION_SECRET` | Any random string, 32+ characters |

Register `https://<your-domain>/callback` as the redirect URL, with the `account:read`, `posts:read` and `posts:write` permissions.

## Project layout

| Path | What it holds |
| --- | --- |
| `public/engine.js` | The handle engine: extraction, cross-post alignment, entity merging, composer matching. Pure functions, tested in Node. |
| `public/app.js` | The single-page UI: scan orchestration, directory editor, composer. |
| `lib/` | Express server: OAuth, session, Buffer GraphQL calls (`buffer.js`), routes (`app.js`). |
| `api/index.js`, `vercel.json` | Vercel entry point. |

The OAuth, session and GraphQL plumbing in `lib/` starts from Buffer's MIT-licensed [app-client starter](https://github.com/bufferapp/buffer-sample-apps) (see `LICENSE-buffer-starter`). Everything else was built during the Buffer Commit window (Nov 2026).

Made by [On First Agency](https://onfirstagency.com). Not an official Buffer product.

# @pipeworx/podcast-parser

What gets repeated across 162 tracked podcasts — claims extracted from 10,000+
episodes, each carrying the measurement behind its status: how many independent
podcasts and speakers repeat it, excluding whoever originated it.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

**LIVE, BYO-ONLY.** Promoted out of `_incubator` and wired into the gateway on
2026-09-14 (fleet #1958), once Bruce's partner key existed and all eight
exported tools returned non-empty payloads against the real API.

**It ships BYO-only even though a Pipeworx platform key exists**, and that is a
deliberate choice, not an oversight. The gateway is AT Cloudflare's limit of 250
text bindings, so `wrangler secret put PLATFORM_CANONCANNON_KEY` is rejected
outright — *"Too many text bindings, found a total of 251, they exceed the limit
of 250"* (code 10055). Declaring `platformKeyEnv` without the secret actually
present would un-sink this pack in routing and send podcast-consensus questions
to a tool that can only refuse, which is strictly worse than an honest
`no_match` — the fda-inspections precedent, fleet #617. So the pack declares no
`platformKeyEnv`, `keyBlockedTools()` keeps it out of `ask_pipeworx` retrieval,
and a caller with their own CanonCannon key can still call it directly with
`_apiKey`.

**To finish it:** free one text binding on the gateway, then land the
`wrangler secret put` and `platformKeyEnv: 'PLATFORM_CANONCANNON_KEY'` in the
SAME change. The key itself is already issued, stored in the canonical
checkout's gitignored `.env`, and verified live. `canon_citations` is separately
held — see the integrity gate.

## Tools

Eight are exported. `canon_citations` is implemented and deliberately held — see
the integrity gate.

- `canon_search(query?, tier?, label?, limit?, cursor?)` — find recurring ideas.
  Each row carries `tier` **and** its `measurement`.
- `canon_get(slug)` — the full entry: claim, evidence, nuance, gaps, related,
  books, plus the measurement spelled out in one sentence beside it.
- `canon_episode_search(query?, podcast?, since?, limit?, cursor?)` — the episode corpus.
- `canon_episode_get(slug)` — one episode with its extracted ideas, guests and books.
- `canon_person_get(slug)` — what one person has actually said, across shows.
- `canon_podcast_list(limit?, cursor?)` — the tracked-show roster, i.e. the denominator
  of the canon bar.
- `canon_podcast_get(slug)` — one tracked show.
- `canon_corpus_stats()` — corpus counts and the bar **currently** in force.
- `canon_citations(slug)` — **HELD.** Every episode citing an idea, with speakers
  and originator involvement.

## Auth

BYO only today: `_apiKey` (`Authorization: Bearer cc_live_...`). Every `/api/v1`
endpoint refuses without one — `GET /stats` with no key is a clean
`401 {"error":"Missing or malformed API key. Send Authorization: Bearer cc_live_..."}`,
so a missing credential is unambiguous rather than looking like an outage.

There is **no `platformKeyEnv`** because we hold no key. When Bruce issues the
partner key, wire `PLATFORM_CANONCANNON_KEY` on the gateway in the SAME change
that adds the `MCP_PACKS` entry (fda-inspections precedent, fleet #617) — a
declared-but-unset platform key sinks every tool in the pack under the key rule
and reads to a caller as a broken pack rather than an unfunded one.

The citations endpoint is additionally restricted to an **internal-tier** key, so
a partner key gets `403` there. That is upstream policy, not our gate.

## The measurement envelope — the whole contract

`tier` is **never** served without a `measurement` sibling, in one of exactly two
shapes:

```json
{ "available": true, "measured_at": "…", "independent_podcasts": 23,
  "independent_speakers": 41, "independent_episodes": 36,
  "threshold": 9, "tracked_podcasts": 162 }

{ "available": false, "reason": "not_yet_measured" | "not_yet_persisted" }
```

We reproduce that nesting exactly instead of flattening it into top-level
nullable fields.
The point is that a caller can tell **"not computed"** from **"computed, and the
answer is zero"**. Zero independent speakers is a strong claim about an entry;
unavailable is no claim at all; a `null` reads as both, and next to a populated
`tier` it reads as *"ignore this, trust the tier"*.

**The two unavailable reasons are different claims and we never collapse them:**

| reason | what it means | how often |
|---|---|---|
| `not_yet_measured` | this entry is newer than the last nightly recompute | per-row, **permanent by design** — true of every entry added today |
| `not_yet_persisted` | the counts are not being stored at all right now | corpus-wide, a real but temporary upstream deficiency |

Render both as a generic "measurement unavailable" and a caller reads *broken*
for something that is fine — manufacturing a false defect report about a healthy
pipeline, immediately after we went to some length not to manufacture a false
consensus count.

`measured_at` is load-bearing, not metadata. CanonCannon's bar is
**bidirectional**: an entry can lose canon status without losing a single
endorsement, purely because the corpus grew around it (the bar is
`ceil(5% of tracked_podcasts)`). And per-row `measured_at` is the only thing that
makes `not_yet_measured` detectable from outside the system at all.

`threshold` is never reported without `tracked_podcasts`. **"9 of 162" is a
claim; "9" alone is a number.**

## Integrity gate on `canon_citations`

`CITATIONS_VERIFICATION_LANDED = false` in `src/index.ts` keeps the tool out of
the exported `tools` array, and `callTool` refuses it with the reason.

CanonCannon's extractor was using canon entries as filing labels, so an entry's
own summary text could count as an endorsement **of itself**. `canon_citations`
returns a consensus count — the shape a caller is least able to check — so
publishing it over contaminated links would put a confident wrong number in front
of every agent that calls it, under the Pipeworx name. A verification pass over
4,218 links is running upstream.

Before flipping the flag:

1. Confirm the verification pass has **completed**. "The API is live" does not
   imply it — the pass is a separate pipeline job on its own schedule.
2. Check rows come back `verified: true`. The endpoint carries the flag per row,
   so the gate is enforced upstream rather than by anyone remembering it.
3. Do **not** hard-code the exclusion rule. Whether the fix changes the rule's
   *shape* or only its *inputs* was still open when this was written, so the tool
   reports the rule the API states, never the intended one.

## Why every tool is `canon_`-prefixed

`episode_get`, `person_get`, `podcast_list` and `corpus_stats` were the names in
CanonCannon's own API-PLAN.md §3, and they are clear across `mcps/*` and the live
gateway today (checked 2026-09-14). They are also generic enough that the next
podcast pack anyone builds — Listen Notes, Podcast Index, a transcript source —
would want four of them.

That matters because of how the gateway resolves a bare `tools/call`: while a name
is unique to one pack it is exposed **bare**, and the moment a second pack exports
it BOTH become reachable only as `<pack>_<name>`. So a future pack would silently
rename this pack's live tools, breaking its `tool-examples.json` keys and every
caller that had learned the bare name. Nine central-bank packs all exporting
`exchange_rates` is the measured precedent, and before it was swept a "Bank of
Japan policy rate" question was answered with Israel's number.

The `canon_` prefix costs nothing now and cannot be added later without a breaking
rename. Re-run the check at promotion anyway — it is cheap:

```bash
for n in canon_search canon_get canon_citations canon_episode_search          canon_episode_get canon_person_get canon_podcast_list          canon_podcast_get canon_corpus_stats; do
  grep -rl "name: '$n'" mcps/*/src/ | head -3
done
scripts/pwcall.sh names canon_          # and against the live gateway
```

The name check now applies: the pack lives at `mcps/podcast-parser/`, which
`pnpm check:collisions` and `check:error-body-leak` do glob. All nine `canon_*`
names were confirmed unique across `mcps/*/src` at promotion.

## Data sources

- <https://canoncannon.com/api/v1/openapi> — the contract. Keyless; **build tool
  schemas from this artifact, not from prose.**
- <https://canoncannon.com/api/v1/canon>, `/canon/{slug}`, `/canon/{slug}/citations`,
  `/episodes`, `/episodes/{slug}`, `/people/{slug}`, `/podcasts`,
  `/podcasts/{slug}`, `/stats` — what the eight-plus-one tools wrap.

Specced upstream and deliberately **not** wrapped yet: `GET /people` (list),
`GET /search` (cross-corpus), `GET /changes?since=` (cheap polling). Add tools
when a caller asks for them; every tool needs a `tool-examples.json` entry
recorded from a call that actually returned rows, and we cannot record one today.

## Things the next person would otherwise rediscover

- **Cursor pagination, never offset.** `?cursor=` is keyset. Terminate on
  `next_cursor: null` or an **empty** page — *never* on a short one, because a
  short page is what silent truncation looks like. Their convention came from the
  same PostgREST 1,000-row cap that has bitten us; see `docs/postgrest-row-cap.md`.
  This pack makes **one upstream request per tool call** and hands the cursor
  back, so a caller can never be given a truncated list that looks complete.
- **We are the only consumer of `/api/v1` on the wire.** CanonCannon's own pages
  render in-process (a Worker fetching its own zone re-enters the Worker), so
  their production traffic never exercises these routes. We will find the API's
  bugs. Treat the OpenAPI artifact as **intent** and the live endpoint as
  **truth** — which is why every response here can carry `contract_warnings`, and
  why those warnings ride out to the caller instead of being swallowed.
- **A contract bug there already survived twenty green assertions** (`canon_related`
  has two foreign keys to `canon`, the embed was ambiguous, every detail request
  500'd in production while every stubbed test passed). The detail endpoints have
  **no declared response schema**, which is why this pack passes their payloads
  through rather than hand-mapping fields nobody here has observed.
- **`citation_count` is not exposed and must not be reintroduced.** It was a text
  column of model prose wearing a number's name.
- **No direct Supabase access, ever.** The canon-cannon Supabase project
  (`admbyodxaxsikiczgfjf`) is a separate project; Pipeworx must never point a
  migration, an ingest or the data-pipeline worker at it. Going over HTTP is what
  makes us inherit the bar when it moves instead of drifting from it. Do not
  "optimise" this into a direct read, and do not ingest their corpus into a
  Pipeworx table.
- **Their `api_keys` table briefly shipped without RLS** (anon-readable and
  anon-writable; caught and closed within the hour, independently re-probed).
  Recorded because the key we will hold is issued from that table.

## Tests

`src/index.test.ts` — 25 assertions over fixtures taken from the published
OpenAPI artifact. They prove our **handling** of the declared contract: the two
unavailable reasons staying distinct, `tier` never passing bare, `null` being
flagged rather than forwarded, a page count never presented as a total, the
refusal saying *"requires an API key"* in those words.

They do **not** prove the live API returns these shapes — nothing here has made a
live call. Replace the fixture payloads with recorded live ones when the key
lands, before anyone calls this pack verified.

## What promotion found (2026-09-14)

All eight exported tools were smoke-tested live against the real API before the
gateway wiring landed, and two defects surfaced that only a live call could:

1. **`canon_corpus_stats` told every caller the bar was unreported while both of
   its numbers sat in the payload.** `/stats` nests the bar as
   `{ corpus: {...}, bar: { threshold, tracked_podcasts, computed_at, rule } }`;
   the pack read `threshold` and `tracked_podcasts` at the top level, found
   neither, and emitted *"CanonCannon did not report both the threshold and the
   tracked-podcast count"*. It now reads the nested shape first and keeps the
   flat one as a fallback. This is the pack's own header rule — treat the
   OpenAPI artifact as INTENT and the live endpoint as TRUTH — failing in the
   window before a key existed to check it.
2. **Three of the eight documented examples pointed at slugs that 404.**
   `zone-2-base-training`, `huberman-lab-sleep-toolkit` and `the-drive` are all
   invented; the real ones are `circadian-rhythm-health-foundation`,
   `pa-392-sleep-apnea` and `peter-attia-drive`. `canon_search({query: "zone 2
   training"})` also returned zero rows, because upstream `q` is a PHRASE match,
   not a token AND — `"zone 2"` matches, `"zone 2 training"` does not. Every
   example in the tool descriptions and in `tool-examples.json` is now a call
   that actually returned rows.

## What is still held

`canon_citations` stays unexported (`CITATIONS_VERIFICATION_LANDED = false`).
The gate is enforced upstream as well as here: as of 2026-09-14
`GET /canon/{slug}/citations` returns **HTTP 403** — *"Citations are not yet
public: the underlying links are pending a verification pass. This endpoint
currently requires an internal key."* Confirm with CanonCannon that the pass has
landed, check rows come back `verified: true`, then flip the flag and record an
example from a call that returned rows.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "podcast-parser": {
      "url": "https://gateway.pipeworx.io/podcast-parser/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/podcast-parser/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "podcast-parser": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-podcast-parser"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-podcast-parser
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Podcast Parser data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * podcast-parser (CanonCannon) — what gets repeated across 162 tracked podcasts.
 *
 * CanonCannon extracts claims from podcast episodes and measures how many
 * INDEPENDENT shows repeat each one, excluding the person who originated it.
 * That measurement is the product: it separates "several unrelated hosts have
 * arrived at this" from "one author on a book tour". 716 canon entries, 10,526
 * episodes, 26,429 extracted ideas, 3,831 people at the time of writing.
 *
 * THIS PACK IS A THIN ADAPTER OVER AN HTTP API, ON PURPOSE. Everything goes
 * through https://canoncannon.com/api/v1 — no Supabase reads, no second copy of
 * the canon logic. The canon bar moves (it is ceil(5% of tracked podcasts), so
 * it rises as the corpus grows); going over the wire means we inherit the new
 * bar instead of drifting from it. The canon-cannon Supabase project is a
 * SEPARATE project and Pipeworx must never point a migration, an ingest or the
 * data-pipeline worker at it. Do not "optimise" this into a direct DB read, and
 * do not ingest their corpus into a Pipeworx table.
 *
 * ── THE MEASUREMENT ENVELOPE IS THE WHOLE CONTRACT ──────────────────────
 *
 * `tier` ("canon" | "observed") is NEVER served without a `measurement`
 * sibling, in one of exactly two forms:
 *
 *   { available: true,  measured_at, independent_podcasts, independent_speakers,
 *     independent_episodes, threshold, tracked_podcasts }
 *   { available: false, reason: "not_yet_measured" | "not_yet_persisted" }
 *
 * We reproduce that nesting exactly rather than flattening it into nullable
 * top-level fields, because the entire point is that a caller can tell "not
 * computed" apart from "computed, and the answer is zero". Zero independent speakers is a
 * strong claim about an entry; unavailable is no claim at all; a null reads as
 * both, and sitting next to a populated `tier` it reads as "ignore this, trust
 * the tier". A verdict with a silently-missing measurement is exactly the
 * failure this pack exists to prevent.
 *
 * The two unavailable reasons are DIFFERENT CLAIMS and we never collapse them:
 *   - not_yet_measured — this entry is newer than the last nightly recompute.
 *     Per-row, permanent by design, and true of every entry created today. The
 *     system working as designed.
 *   - not_yet_persisted — the system cannot currently measure anything
 *     (pre-migration state). A real, temporary deficiency.
 * Render both as a generic "unavailable" and a caller reads "broken" for
 * something that is fine — manufacturing a false defect report about a healthy
 * pipeline, right after we went to some length not to manufacture a false
 * consensus count.
 *
 * `measured_at` is load-bearing, not metadata. The bar is BIDIRECTIONAL: an
 * entry can lose canon status without losing a single endorsement, purely
 * because the corpus grew around it. So a stale measurement is its own failure
 * mode — and per-row `measured_at` is the only thing that makes
 * `not_yet_measured` detectable from outside the system.
 *
 * `threshold` is never reported without `tracked_podcasts`. "9 of 162" is a
 * claim; "9" alone is a number.
 *
 * ── canon_citations IS DELIBERATELY NOT EXPORTED YET ────────────────────
 *
 * See CITATIONS_VERIFICATION_LANDED below. It is implemented and held.
 *
 * ── PAGING ─────────────────────────────────────────────────────────────
 *
 * Keyset cursors, never offset. One upstream request per tool call: we return
 * the page plus its `next_cursor` rather than looping, so a caller can never be
 * handed a silently truncated "complete" list. If you ever add a paging loop
 * here, read docs/postgrest-row-cap.md first — terminate on an EMPTY page, never
 * on a short one, because a short page is what silent truncation looks like.
 *
 * ── WE ARE THE ONLY CONSUMER OF /api/v1 ON THE WIRE ─────────────────────
 *
 * CanonCannon's own pages render in-process (a Worker fetching its own zone
 * re-enters the Worker). So their production traffic never exercises these
 * routes and we will be the ones who find the API's bugs. Treat the OpenAPI
 * artifact as INTENT and the live endpoint as TRUTH — which is why every
 * response here can carry `contract_warnings`, and why those warnings are
 * surfaced to the caller rather than swallowed.
 */


const API_BASE = 'https://canoncannon.com/api/v1';
// The UA still says `canoncannon` after the pack was renamed to
// `podcast-parser` (fleet #2032, 2026-09-16) and that is DELIBERATE. This
// string is an on-the-wire identifier a live partner may be matching or
// counting on; the rename was of OUR directory, and changing what we call
// ourselves to their API is a second, partner-facing change with nothing in
// this task asking for it. Change it in a change CanonCannon is told about.
const UA = 'pipeworx-mcp-canoncannon/1.0 (+https://pipeworx.io)';
const SOURCE = 'CanonCannon (canoncannon.com/api/v1)';
const MAX_LIMIT = 100;

/**
 * FALSE until CanonCannon confirms the citation VERIFICATION PASS has landed.
 *
 * Their extractor was using canon entries as filing labels, so an entry's own
 * summary text counted as an endorsement of itself. canon_citations is precisely
 * the tool that surfaces that, and it returns a CONSENSUS COUNT — the shape a
 * caller is least able to check. Publishing it contaminated puts a wrong number
 * in front of every agent that calls it, under the Pipeworx name.
 *
 * BEFORE FLIPPING THIS TO true:
 *  1. Confirm with CanonCannon (Vera) that the verification pass over the 4,218
 *     citation links has COMPLETED. "The API is live" does not imply it — the
 *     pass is a separate pipeline job on its own schedule.
 *  2. Call /canon/{slug}/citations with the partner key and check that rows come
 *     back `verified: true`. The endpoint carries the flag per row, so the gate
 *     is enforced upstream rather than by anyone remembering it.
 *  3. Do NOT hard-code the exclusion rule. Whether the fix changes the SHAPE of
 *     the rule or only its inputs was still open when this was written, so the
 *     tool reports the rule IN FORCE as the API states it, never the intended
 *     one.
 * Then move CITATIONS_TOOL into `tools` and record a tool example from a call
 * that actually returned rows.
 */
const CITATIONS_VERIFICATION_LANDED = false;

// ── Measurement envelope ────────────────────────────────────────────────

export type Measurement =
  | {
      available: true;
      measured_at: string;
      independent_podcasts: number;
      independent_speakers: number;
      independent_episodes: number;
      threshold: number;
      tracked_podcasts: number;
    }
  | { available: false; reason: 'not_yet_measured' | 'not_yet_persisted' };

const MEASUREMENT_REQUIRED_FIELDS = [
  'measured_at',
  'independent_podcasts',
  'independent_speakers',
  'independent_episodes',
  'threshold',
  'tracked_podcasts',
] as const;

const UNAVAILABLE_REASONS = new Set(['not_yet_measured', 'not_yet_persisted']);

const MEASUREMENT_LEGEND =
  'Every `tier` carries a `measurement` sibling in one of two shapes: ' +
  '{available:true, …counts} or {available:false, reason}. Read the measurement, not the tier alone — ' +
  '`tier: "canon"` only means the counts cleared the bar that was in force when `measured_at` says they were checked. ' +
  'The bar is bidirectional: an entry can lose canon status without losing an endorsement, purely because the corpus grew. ' +
  'reason "not_yet_measured" = this entry is newer than the last nightly recompute (normal for a new entry, not a fault); ' +
  'reason "not_yet_persisted" = the counts are not being stored at all right now (a real, temporary deficiency upstream).';

/** One plain-English sentence for a measurement. Never drops the denominator. */
export function describeMeasurement(m: unknown): string {
  if (!m || typeof m !== 'object') {
    return 'No measurement accompanied this tier, which the CanonCannon API contract forbids — treat the tier as unverified.';
  }
  const mm = m as Record<string, unknown>;
  if (mm.available === true) {
    const pods = mm.independent_podcasts;
    const speakers = mm.independent_speakers;
    const eps = mm.independent_episodes;
    const threshold = mm.threshold;
    const tracked = mm.tracked_podcasts;
    const bar =
      typeof threshold === 'number' && typeof tracked === 'number'
        ? `the bar is ${threshold} of ${tracked} tracked podcasts`
        : 'the bar in force was not reported';
    const cleared =
      typeof pods === 'number' && typeof threshold === 'number'
        ? pods >= threshold
          ? ' — cleared'
          : ' — not cleared'
        : '';
    return (
      `${pods} independent podcast(s) raised this, ${speakers} independent speaker(s) across ${eps} episode(s); ` +
      `${bar}${cleared}. Last verified ${mm.measured_at}.`
    );
  }
  if (mm.available === false) {
    if (mm.reason === 'not_yet_measured') {
      return 'Not measured yet: this entry is newer than the last nightly recompute, so no independent-podcast count exists for it. Normal for a recently added entry — not a fault, and not a count of zero.';
    }
    if (mm.reason === 'not_yet_persisted') {
      return 'Measurement unavailable upstream: CanonCannon is not currently storing the independent-podcast counts, so nothing can be measured for any entry right now. A temporary deficiency — the tier shown cannot be checked against its numbers.';
    }
    return `Measurement unavailable, reason reported as ${JSON.stringify(mm.reason)} — not one of the two documented reasons, so what it means is unknown.`;
  }
  return 'Measurement present but its `available` flag is neither true nor false, so it cannot be interpreted.';
}

/**
 * Report where the live response DISAGREES with the published contract.
 *
 * Not defensive noise: their own caution is to treat the spec as intent and the
 * endpoint as truth, and a contract bug there already got past twenty green
 * assertions. A warning a caller can see is the only kind that is worth
 * anything, so these ride out on the response.
 */
export function collectContractWarnings(value: unknown, path = '$', depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length >= 12) return out;
  if (Array.isArray(value)) {
    // Sample rather than walk every row: one violated row and a thousand
    // violated rows are the same finding, and the budget above is what keeps a
    // 100-row page from spending itself on repeats.
    for (let i = 0; i < Math.min(value.length, 5); i++) {
      collectContractWarnings(value[i], `${path}[${i}]`, depth + 1, out);
    }
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const obj = value as Record<string, unknown>;

  if ('tier' in obj) {
    if (!('measurement' in obj)) {
      out.push(`${path}: carries \`tier\` but no \`measurement\`. The API contract says tier is never served without it — the tier here is unverifiable.`);
    } else if (obj.measurement === null) {
      out.push(`${path}.measurement is null. The contract forbids null precisely because it reads as both "not computed" and "computed, zero" — two opposite claims.`);
    } else if (typeof obj.measurement === 'object') {
      const m = obj.measurement as Record<string, unknown>;
      if (m.available === true) {
        const missing = MEASUREMENT_REQUIRED_FIELDS.filter((f) => m[f] === undefined || m[f] === null);
        if (missing.length) {
          out.push(`${path}.measurement says available:true but is missing ${missing.join(', ')}. An available measurement must carry all six values.`);
        }
      } else if (m.available === false) {
        if (typeof m.reason !== 'string' || !UNAVAILABLE_REASONS.has(m.reason)) {
          out.push(`${path}.measurement says available:false with reason ${JSON.stringify(m.reason)}, which is not one of not_yet_measured / not_yet_persisted.`);
        }
      } else {
        out.push(`${path}.measurement.available is ${JSON.stringify(m.available)}, neither true nor false.`);
      }
    }
  }

  for (const [k, v] of Object.entries(obj)) {
    if (k === 'measurement') continue;
    if (v && typeof v === 'object') collectContractWarnings(v, `${path}.${k}`, depth + 1, out);
  }
  return out;
}

/** How many rows on this page carry a usable measurement, and why the rest do not. */
export function tallyMeasurements(items: unknown[]): {
  available: number;
  not_yet_measured: number;
  not_yet_persisted: number;
  absent_or_malformed: number;
} {
  const tally = { available: 0, not_yet_measured: 0, not_yet_persisted: 0, absent_or_malformed: 0 };
  for (const item of items) {
    const m = (item as Record<string, unknown> | null)?.measurement as Record<string, unknown> | null | undefined;
    if (!m || typeof m !== 'object') { tally.absent_or_malformed++; continue; }
    if (m.available === true) { tally.available++; continue; }
    if (m.available === false && m.reason === 'not_yet_measured') { tally.not_yet_measured++; continue; }
    if (m.available === false && m.reason === 'not_yet_persisted') { tally.not_yet_persisted++; continue; }
    tally.absent_or_malformed++;
  }
  return tally;
}

// ── HTTP ────────────────────────────────────────────────────────────────

function requireKey(apiKey: string | undefined, tool: string): string {
  if (!apiKey) {
    throw new Error(
      `${tool} requires an API key: every CanonCannon /api/v1 endpoint refuses without one, as \`Authorization: Bearer cc_live_...\`. Pass it as _apiKey. Keys are issued by CanonCannon — https://canoncannon.com`,
    );
  }
  return apiKey;
}

function ccError(status: number, bodyText: string, tool: string): Error {
  // summarizeErrorBody, not a raw slice: if CanonCannon ever answers with a
  // Cloudflare interstitial or a login page instead of its JSON error, a raw
  // slice pastes 300 characters of HTML into the message a caller reads. Their
  // own 401 is a clean JSON sentence today, which is exactly when this is
  // easiest to get wrong.
  const upstream = summarizeErrorBody(bodyText);
  const detail = upstream ? ` Upstream said: ${upstream}` : '';
  if (status === 401) {
    return new Error(
      `${tool} requires an API key that CanonCannon accepts (HTTP 401 — missing or malformed key). Pass a valid cc_live_... key as _apiKey; keys are issued by CanonCannon at https://canoncannon.com.${detail}`,
    );
  }
  if (status === 403) {
    return new Error(
      `${tool}: HTTP 403 — this endpoint is restricted to an internal-tier CanonCannon key, and the key used is not one. The citations endpoint in particular is internal-only until CanonCannon opens it.${detail}`,
    );
  }
  if (status === 404) {
    return new Error(`${tool}: no such slug (HTTP 404). Slugs are CanonCannon's own identifiers — find one with canon_search, canon_episode_search or canon_podcast_list rather than guessing.${detail}`);
  }
  if (status === 400) {
    return new Error(`${tool}: CanonCannon rejected the arguments (HTTP 400).${detail}`);
  }
  if (status === 429) {
    return new Error(`${tool}: rate limited by CanonCannon (HTTP 429). Their limit is per key and per tier; retry after a pause rather than in a loop.${detail}`);
  }
  return new Error(`${tool}: HTTP ${status} from canoncannon.com/api/v1.${detail}`);
}

interface CcResult {
  body: unknown;
  apiVersion: string | null;
}

async function ccGet(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string | undefined,
  tool: string,
): Promise<CcResult> {
  const key = requireKey(apiKey, tool);
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': UA,
      },
    },
    'CanonCannon',
  );
  if (!res.ok) throw ccError(res.status, await res.text().catch(() => ''), tool);
  const apiVersion = res.headers.get('x-api-version');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${tool}: CanonCannon returned HTTP ${res.status} with a body that is not JSON.`);
  }
  return { body, apiVersion };
}

function clampLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function requireSlug(args: Record<string, unknown>, tool: string): string {
  const slug = str(args.slug);
  if (!slug) throw new Error(`${tool} needs a \`slug\` — CanonCannon's own identifier for the entry. Find one with canon_search, canon_episode_search or canon_podcast_list.`);
  return slug;
}

/** Common tail on every response: where it came from, and any contract disagreement. */
function envelope(result: CcResult, extra: Record<string, unknown>): Record<string, unknown> {
  const warnings = collectContractWarnings(result.body);
  return {
    ...extra,
    source: SOURCE,
    api_version: result.apiVersion,
    ...(warnings.length ? { contract_warnings: warnings } : {}),
  };
}

/**
 * A page, passed through with its cursor.
 *
 * `count` is deliberately described as "on this page" everywhere it appears. A
 * page count presented as a total is the silent-zero failure's twin: both are a
 * number the caller cannot tell is partial.
 */
function pageEnvelope(
  result: CcResult,
  tool: string,
  emptyNote: string,
): Record<string, unknown> {
  const body = (result.body ?? {}) as Record<string, unknown>;
  const items = Array.isArray(body.items) ? body.items : [];
  const nextCursor = (body.next_cursor ?? null) as string | null;
  const carriesTier = items.some((i) => i && typeof i === 'object' && 'tier' in (i as object));
  return envelope(result, {
    items,
    count_on_this_page: items.length,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    paging: nextCursor
      ? `More rows exist. Call ${tool} again with cursor: "${nextCursor}". Cursors are keyset, not offsets — never skip ahead, and stop on an empty page rather than a short one.`
      : 'This is the last page (next_cursor is null).',
    ...(items.length === 0 ? { note: emptyNote } : {}),
    ...(carriesTier
      ? { measurement_states: tallyMeasurements(items), measurement_legend: MEASUREMENT_LEGEND }
      : {}),
  });
}

/** A single entity, passed through with the measurement spelled out beside it. */
function entityEnvelope(result: CcResult, entityKey: string): Record<string, unknown> {
  const body = result.body as Record<string, unknown> | null;
  const hasTier = !!body && typeof body === 'object' && 'tier' in body;
  return envelope(result, {
    [entityKey]: body,
    ...(hasTier
      ? {
          measurement_note: describeMeasurement((body as Record<string, unknown>).measurement),
          measurement_legend: MEASUREMENT_LEGEND,
        }
      : {}),
  });
}

// ── Tool implementations ────────────────────────────────────────────────

async function canonSearch(args: Record<string, unknown>, apiKey?: string) {
  const q = str(args.query);
  const tier = str(args.tier);
  if (tier && tier !== 'canon' && tier !== 'observed') {
    throw new Error('canon_search: `tier` must be "canon" or "observed". CanonCannon has no other tiers.');
  }
  const result = await ccGet(
    '/canon',
    { q, tier, label: str(args.label), cursor: str(args.cursor), limit: clampLimit(args.limit, 25) },
    apiKey,
    'canon_search',
  );
  return pageEnvelope(
    result,
    'canon_search',
    'No canon entries matched. CanonCannon indexes claims extracted from podcast episodes, not the web at large — try broader wording, drop the tier filter (`observed` entries have not cleared the bar and are excluded when you ask for `canon`), or search the whole corpus differently.',
  );
}

async function canonGet(args: Record<string, unknown>, apiKey?: string) {
  const slug = requireSlug(args, 'canon_get');
  const result = await ccGet(`/canon/${encodeURIComponent(slug)}`, {}, apiKey, 'canon_get');
  return entityEnvelope(result, 'canon_entry');
}

/**
 * HELD — not in `tools`. See CITATIONS_VERIFICATION_LANDED.
 *
 * Passes `verified` and `originator_involved` through per row untouched and
 * states the rule the API reports rather than any rule written here. If rows
 * come back unverified it says so at the top of the response, because a
 * consensus count computed over contaminated links is worse than no count.
 */
async function canonCitations(args: Record<string, unknown>, apiKey?: string) {
  const slug = requireSlug(args, 'canon_citations');
  const result = await ccGet(`/canon/${encodeURIComponent(slug)}/citations`, {}, apiKey, 'canon_citations');
  const body = (result.body ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(body.items) ? body.items : Array.isArray(body.citations) ? body.citations : [];
  const unverified = rows.filter((r) => (r as Record<string, unknown> | null)?.verified !== true).length;
  return envelope(result, {
    citations: body,
    count_on_this_page: rows.length,
    exclusion_rule_in_force:
      body.exclusion_rule ??
      'Not stated by the API in this response. Do not assume the documented rule is the one in force — report this as a contract gap rather than filling it in.',
    verification:
      unverified === 0 && rows.length > 0
        ? 'Every citation row on this page reports verified: true — self-endorsement has been excluded upstream.'
        : `${unverified} of ${rows.length} citation row(s) on this page are NOT marked verified. CanonCannon's extractor used canon entries as filing labels, so an entry's own summary text could count as an endorsement of itself. Do not derive a consensus count from unverified rows: use the \`measurement\` on the canon entry, which is computed by the bar's own rule.`,
    measurement_legend: MEASUREMENT_LEGEND,
  });
}

async function episodeSearch(args: Record<string, unknown>, apiKey?: string) {
  const since = str(args.since);
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error('canon_episode_search: `since` must be a date as YYYY-MM-DD.');
  }
  const result = await ccGet(
    '/episodes',
    { q: str(args.query), podcast: str(args.podcast), since, cursor: str(args.cursor), limit: clampLimit(args.limit, 25) },
    apiKey,
    'canon_episode_search',
  );
  return pageEnvelope(
    result,
    'canon_episode_search',
    'No episodes matched. Episodes are keyed on CanonCannon\'s own podcast slugs — get one from canon_podcast_list before filtering by `podcast`, and note `since` filters on publication date.',
  );
}

async function episodeGet(args: Record<string, unknown>, apiKey?: string) {
  const slug = requireSlug(args, 'canon_episode_get');
  const result = await ccGet(`/episodes/${encodeURIComponent(slug)}`, {}, apiKey, 'canon_episode_get');
  return entityEnvelope(result, 'episode');
}

async function personGet(args: Record<string, unknown>, apiKey?: string) {
  const slug = requireSlug(args, 'canon_person_get');
  const result = await ccGet(`/people/${encodeURIComponent(slug)}`, {}, apiKey, 'canon_person_get');
  return entityEnvelope(result, 'person');
}

async function podcastList(args: Record<string, unknown>, apiKey?: string) {
  const result = await ccGet(
    '/podcasts',
    { cursor: str(args.cursor), limit: clampLimit(args.limit, 50) },
    apiKey,
    'canon_podcast_list',
  );
  return pageEnvelope(result, 'canon_podcast_list', 'No podcasts returned, which would mean the tracked-show roster is empty — that is a defect upstream, not an answer. Check canon_corpus_stats.');
}

async function podcastGet(args: Record<string, unknown>, apiKey?: string) {
  const slug = requireSlug(args, 'canon_podcast_get');
  const result = await ccGet(`/podcasts/${encodeURIComponent(slug)}`, {}, apiKey, 'canon_podcast_get');
  return entityEnvelope(result, 'podcast');
}

async function corpusStats(_args: Record<string, unknown>, apiKey?: string) {
  const result = await ccGet('/stats', {}, apiKey, 'canon_corpus_stats');
  const body = (result.body ?? {}) as Record<string, unknown>;
  // The bar lives under `bar` on the live endpoint ({ corpus: {...}, bar: {
  // threshold, tracked_podcasts, computed_at, rule } }), not at the top level
  // the plan sketched. Read the nested shape FIRST and keep the flat one as a
  // fallback so this survives either. Getting this wrong is not cosmetic: both
  // numbers were present and we told every caller we had not been given them,
  // which suppresses the one quote the tool exists to license.
  const bar = (body.bar ?? {}) as Record<string, unknown>;
  const corpus = (body.corpus ?? {}) as Record<string, unknown>;
  const threshold = bar.threshold ?? body.threshold ?? body.bar_threshold;
  const tracked = bar.tracked_podcasts ?? body.tracked_podcasts ?? corpus.tracked_podcasts;
  return envelope(result, {
    stats: body,
    bar_note:
      typeof threshold === 'number' && typeof tracked === 'number'
        ? `The bar in force is ${threshold} independent podcasts out of ${tracked} tracked (ceil(5%)). Quote both numbers — the threshold without its denominator is just a number, and the bar RISES as the corpus grows, so an entry can lose canon status without losing an endorsement.`
        : 'CanonCannon did not report both the threshold and the tracked-podcast count in this response. Do not quote a bar without its denominator.',
  });
}

// ── Tool definitions ────────────────────────────────────────────────────

const KEY_ARG = {
  type: 'string',
  description:
    'CanonCannon API key (cc_live_...). Every /api/v1 endpoint refuses without it. Keys are issued by CanonCannon — https://canoncannon.com',
} as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'canon_search',
    description:
      'Search CanonCannon for ideas that recur across podcasts — claims extracted from 10,000+ episodes of 162 tracked shows, each with the MEASUREMENT behind its status: how many independent podcasts and speakers repeat it (excluding whoever originated it) and the bar in force. Use this to tell real cross-show consensus from one author on a book tour. Requires a CanonCannon API key via _apiKey. Example: canon_search({ query: "longevity" }) — `q` is matched as a PHRASE upstream, so prefer one or two words ("zone 2", not "zone 2 training").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text search over canon titles, claims and summaries, e.g. "creatine cognition".' },
        tier: { type: 'string', enum: ['canon', 'observed'], description: '"canon" = cleared the independent-spread bar; "observed" = extracted but not cleared. Omitting this returns both.' },
        label: { type: 'string', description: 'Filter to one label, e.g. "Canon", "Curious", "Novel", or an editorial label.' },
        limit: { type: 'number', description: 'Entries per page, 1-100. Default 25.' },
        cursor: { type: 'string', description: 'Keyset cursor from a previous call\'s next_cursor. Not an offset.' },
        _apiKey: KEY_ARG,
      },
    },
  },
  {
    name: 'canon_get',
    description:
      'The full CanonCannon entry for one idea — the claim, the evidence behind it, the nuance and gaps, related entries and books — alongside its measurement (independent podcast count, independent speaker count, the bar in force, and when it was last verified). Get the slug from canon_search. Requires a CanonCannon API key via _apiKey. Example: canon_get({ slug: "circadian-rhythm-health-foundation" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'CanonCannon canon slug, from canon_search.' },
        _apiKey: KEY_ARG,
      },
      required: ['slug'],
    },
  },
  {
    name: 'canon_episode_search',
    description:
      'Search the CanonCannon episode corpus — 10,000+ podcast episodes with the ideas, guests and books extracted from each. Filter by show, by publication date, or by free text. Requires a CanonCannon API key via _apiKey. Example: canon_episode_search({ query: "sleep apnea", since: "2026-01-01" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text search over episode titles and extracted content.' },
        podcast: { type: 'string', description: 'CanonCannon podcast slug, from canon_podcast_list.' },
        since: { type: 'string', description: 'Only episodes published on or after this date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Episodes per page, 1-100. Default 25.' },
        cursor: { type: 'string', description: 'Keyset cursor from a previous call\'s next_cursor.' },
        _apiKey: KEY_ARG,
      },
    },
  },
  {
    name: 'canon_episode_get',
    description:
      'One podcast episode from CanonCannon with everything extracted from it — the ideas it raised, its guests, and the books mentioned. Get the slug from canon_episode_search. Requires a CanonCannon API key via _apiKey. Example: canon_episode_get({ slug: "pa-392-sleep-apnea" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'CanonCannon episode slug, from canon_episode_search.' },
        _apiKey: KEY_ARG,
      },
      required: ['slug'],
    },
  },
  {
    name: 'canon_person_get',
    description:
      'What one person has actually said across podcasts, per CanonCannon — their appearances by show and the ideas attributed to them, drawn from 3,800+ people in the corpus. Answers "does this person keep making this claim, and where" rather than "who is this person". Requires a CanonCannon API key via _apiKey. Example: canon_person_get({ slug: "peter-attia" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'CanonCannon person slug, from canon_search or canon_episode_get.' },
        _apiKey: KEY_ARG,
      },
      required: ['slug'],
    },
  },
  {
    name: 'canon_podcast_list',
    description:
      'Every podcast CanonCannon tracks, with its episode count — the roster that forms the denominator of the canon bar (an idea needs ceil(5%) of these shows to clear it). Requires a CanonCannon API key via _apiKey. Example: canon_podcast_list({ limit: 100 }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Podcasts per page, 1-100. Default 50.' },
        cursor: { type: 'string', description: 'Keyset cursor from a previous call\'s next_cursor.' },
        _apiKey: KEY_ARG,
      },
    },
  },
  {
    name: 'canon_podcast_get',
    description:
      'One tracked show from CanonCannon, with its episode count and metadata. Get the slug from canon_podcast_list. Requires a CanonCannon API key via _apiKey. Example: canon_podcast_get({ slug: "peter-attia-drive" }).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'CanonCannon podcast slug, from canon_podcast_list.' },
        _apiKey: KEY_ARG,
      },
      required: ['slug'],
    },
  },
  {
    name: 'canon_corpus_stats',
    description:
      'CanonCannon corpus size and the canon bar CURRENTLY in force — entry, episode, idea and person counts, the tracked-podcast count, and the independent-podcast threshold an idea must clear. Call this to state the standard you are quoting: the bar is ceil(5% of tracked podcasts), so it rises as the corpus grows. Requires a CanonCannon API key via _apiKey. Example: canon_corpus_stats({}).',
    inputSchema: {
      type: 'object' as const,
      properties: { _apiKey: KEY_ARG },
    },
  },
];

/** Held out of `tools` until the verification pass lands — see CITATIONS_VERIFICATION_LANDED. */
const CITATIONS_TOOL: McpToolExport['tools'][number] = {
  name: 'canon_citations',
  description:
    'Every episode that cites one CanonCannon idea — which show, when, which speakers, and whether the originator was involved. This is the tool that answers "is this actually consensus, or one person repeating themselves", because the count excludes whoever originated the idea. Requires a CanonCannon API key via _apiKey. Example: canon_citations({ slug: "circadian-rhythm-health-foundation" }).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      slug: { type: 'string', description: 'CanonCannon canon slug, from canon_search.' },
      _apiKey: KEY_ARG,
    },
    required: ['slug'],
  },
};

if (CITATIONS_VERIFICATION_LANDED) tools.push(CITATIONS_TOOL);

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined) || undefined;
  delete args._apiKey;

  switch (name) {
    case 'canon_search':
      return canonSearch(args, apiKey);
    case 'canon_get':
      return canonGet(args, apiKey);
    case 'canon_episode_search':
      return episodeSearch(args, apiKey);
    case 'canon_episode_get':
      return episodeGet(args, apiKey);
    case 'canon_person_get':
      return personGet(args, apiKey);
    case 'canon_podcast_list':
      return podcastList(args, apiKey);
    case 'canon_podcast_get':
      return podcastGet(args, apiKey);
    case 'canon_corpus_stats':
      return corpusStats(args, apiKey);
    case 'canon_citations':
      if (!CITATIONS_VERIFICATION_LANDED) {
        throw new Error(
          'canon_citations is not published yet. CanonCannon\'s citation links are being re-verified: the extractor used canon entries as filing labels, so an entry\'s own summary text could count as an endorsement of itself. Publishing a consensus count over contaminated links would put a confident wrong number in front of callers who cannot check it. Use canon_get instead — its `measurement` is computed by the bar\'s own rule and carries the independent podcast and speaker counts.',
        );
      }
      return canonCitations(args, apiKey);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool, CITATIONS_TOOL, canonCitations, MEASUREMENT_LEGEND };
export default { tools, callTool, meter: { credits: 1 }, provider: 'CanonCannon' } satisfies McpToolExport;

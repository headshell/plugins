// The SoundCloud provider plugin (api 5, D-069, D-076, D-078, D-086).
//
// Phase 2 §2.2's reference plugin; moved from Python to JS in D-069. Its job is
// not to offer a catalog but to prove that the plugin contract can be written
// outside the core: there's no Rust here, only the `host` object the engine
// gives. Nothing has to be installed on the user's machine.
//
// The scope is deliberately narrow — `search` + `stream` + the track's cover
// (api 3). No lyrics (api 4): SoundCloud keeps none, so the manifest says
// `"lyrics": false` and the app asks LRCLIB for them itself. Audio is never relayed (K3): the resolved address is handed to the
// core, and the core fetches the stream. Nothing circumvents DRM (D-026):
// SoundCloud's own `progressive` MP3 transcoding returns a signed address, and
// we pass it on as it is.
//
// Measurement (2026-09-01, a sample of 200 tracks): 99% of the tracks have a
// `progressive` variant; 1% offer only HLS. We didn't write an HLS decoder; for
// that 1% we return an explicit error — not a silent empty result (K9).

const VERSION = "0.5.0";
const HOME_URL = "https://soundcloud.com/";
const API_BASE = "https://api-v2.soundcloud.com";
const HEADERS = { "User-Agent": `headshell-soundcloud/${VERSION}` };

// The total budget for discovery. If it runs out we say "couldn't find it" —
// before the call's own time (20 s) runs out, while we can still say why.
const DISCOVERY_BUDGET_MS = 15000;

const ASSET_PATTERN = /https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g;
const CLIENT_ID_PATTERN = /client_id[=:]"?([A-Za-z0-9]{32})/;
const CLIENT_ID_SHAPE = /^[A-Za-z0-9]{32}$/;

// The client_id and where it came from: "secret" | "cache" | "discovery".
// health() reports it (D-043).
let clientId = null;
let clientIdSource = null;

/** The server returned a code outside 2xx. `status` is for the caller to tell cases apart. */
class StatusError extends Error {
  constructor(status, url) {
    super(`SoundCloud returned HTTP ${status} (${url.split("?")[0]})`);
    this.status = status;
  }
}

// --- HTTP ----------------------------------------------------------------------

function get(url) {
  let res;
  try {
    res = host.http.get(url, HEADERS);
  } catch (err) {
    throw new Error(`SoundCloud could not be reached: ${err.message}`);
  }
  if (res.status === 429) {
    throw new Error("SoundCloud's quota is used up (429); wait a while");
  }
  if (!res.ok) throw new StatusError(res.status, url);
  return res.body;
}

function getJson(url) {
  const body = get(url);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`SoundCloud gave an answer that isn't JSON: ${err.message}`);
  }
}

function query(params) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function apiUrl(path, params) {
  return `${API_BASE}${path}?${query({ ...params, client_id: resolveClientId() })}`;
}

/** A call to `api-v2`. If the client_id is rejected, it refreshes it **once** and retries. */
function apiGet(path, params = {}) {
  try {
    return getJson(apiUrl(path, params));
  } catch (err) {
    // A 404 isn't an error but a "doesn't exist" answer; swallowing it here would
    // reduce two cases the caller has to tell apart to a single diagnosis (K9).
    if (!(err instanceof StatusError) || (err.status !== 401 && err.status !== 403)) throw err;
    // We can't refresh a key the user gave — they should know.
    if (clientIdSource === "secret") {
      throw new Error(
        `The client_id you gave was rejected (HTTP ${err.status}). ` +
          "If you run `headshell secret remove plugin:soundcloud client_id`, the plugin discovers one itself.",
      );
    }
    host.log.info(`client_id rejected (HTTP ${err.status}), discovering it again`);
    forgetClientId();
    try {
      return getJson(apiUrl(path, params));
    } catch (retry) {
      if (retry instanceof StatusError) {
        throw new Error(
          `We were rejected with a fresh client_id too (HTTP ${retry.status}); ` +
            "SoundCloud's web surface may have changed.",
        );
      }
      throw retry;
    }
  }
}

// --- resolving the client_id (D-043) ---------------------------------------------
//
// Three sources, in this order: the user's secret → the cache in the engine's
// store → discovery. The order is deliberate: if the user gave a key, we use it
// and don't work around it.

function forgetClientId() {
  clientId = null;
  clientIdSource = null;
  host.storage.remove("client_id");
}

/**
 * Extracts the key SoundCloud's web client uses from its JS assets.
 *
 * It isn't a documented endpoint; it can break without warning. What happens when
 * it breaks is clear: an error, and "give your own client_id" to the user.
 */
function discoverClientId() {
  const deadline = Date.now() + DISCOVERY_BUDGET_MS;
  const home = get(HOME_URL);
  const assets = home.match(ASSET_PATTERN) ?? [];
  if (assets.length === 0) throw new Error("no JS asset found on SoundCloud's home page");

  // From the end to the start: in practice the key sits in the last bundles, and
  // scanning from the start would mean downloading a few megabytes for nothing.
  for (const asset of assets.reverse()) {
    if (Date.now() > deadline) break;
    let body;
    try {
      body = get(asset);
    } catch (err) {
      host.log.warn(`could not read a JS asset (${asset}): ${err.message}`);
      continue;
    }
    const found = body.match(CLIENT_ID_PATTERN);
    if (found) return found[1];
  }
  throw new Error(
    "could not discover a client_id (SoundCloud's web surface may have changed). " +
      "You can give your own key with `headshell secret set plugin:soundcloud client_id`.",
  );
}

/**
 * Lazy resolution: not while loading but on the first real call. The engine
 * doesn't allow going to the network while loading anyway; discovery is network
 * work and belongs here.
 */
function resolveClientId() {
  if (clientId) return clientId;

  const secret = host.secrets.get("client_id");
  if (secret !== null && secret.trim() !== "") {
    clientId = secret.trim();
    clientIdSource = "secret";
    return clientId;
  }

  const cached = host.storage.get("client_id");
  // If a broken cache were silently accepted, the error would show as
  // SoundCloud's 401 — that is, in the wrong place.
  if (cached !== null && CLIENT_ID_SHAPE.test(cached)) {
    clientId = cached;
    clientIdSource = "cache";
    return clientId;
  }

  clientId = discoverClientId();
  clientIdSource = "discovery";
  try {
    host.storage.set("client_id", clientId);
    host.log.info("client_id discovered and cached");
  } catch (err) {
    // The cache is a speed-up; failing to write it doesn't stop the work, but it
    // doesn't stay silent either.
    host.log.warn(`could not write the client_id to the cache: ${err.message}`);
  }
  return clientId;
}

// --- track conversion ------------------------------------------------------------

/**
 * Turns an `api-v2` track into the contract's track shape.
 *
 * SoundCloud has no concept of an album (tracks belong to sets); `album` stays
 * empty. The ISRC is only under `publisher_metadata`, and most tracks don't have
 * one.
 */
function toTrack(track) {
  const publisher = track.publisher_metadata ?? {};
  const user = track.user ?? {};
  let title = track.title || "Untitled";
  // A 30-second preview, not the full track. Its duration already comes as
  // 30000; we say so in the title too, so the user isn't surprised while playing.
  if (track.policy === "SNIP") title = `${title} [preview]`;

  const result = {
    id: String(track.id),
    artist: publisher.artist || user.username || "Unknown artist",
    title,
    duration_ms: Math.trunc(Number(track.duration) || 0),
  };
  if (publisher.isrc) result.isrc = publisher.isrc;
  return result;
}

/**
 * The resolution address of the progressive (plain HTTP) MP3 transcoding. The HLS
 * variants are skipped on purpose: the core expects a plain stream.
 */
function progressiveUrl(track) {
  const transcodings = track.media?.transcodings ?? [];
  const progressive = transcodings.find((t) => t.format?.protocol === "progressive");
  return progressive?.url ?? null;
}

// --- the contract ------------------------------------------------------------------

export function health() {
  let payload;
  try {
    // The cheapest real call: it tests the client_id and the endpoint together.
    payload = apiGet("/search/tracks", { q: "a", limit: 1 });
  } catch (err) {
    // Being unreachable is a health answer, not an error.
    return { reachable: false, detail: err.message };
  }
  const total = payload.total_results;
  return {
    reachable: true,
    // The catalog size is a number that changes with the query, not the
    // provider's total. Saying "I don't know" is better than giving a wrong number.
    track_count: null,
    detail:
      `SoundCloud API v2, client_id source: ${clientIdSource}` +
      (Number.isInteger(total) ? `, a sample query gives ${total} results` : ""),
  };
}

export function search(text, limit) {
  const q = String(text ?? "").trim();
  if (q === "") return [];
  const size = Math.max(1, Math.min(Number(limit) || 20, 200));

  const payload = apiGet("/search/tracks", { q, limit: size });
  const tracks = [];
  let skipped = 0;
  for (const track of payload.collection ?? []) {
    if (track.kind !== "track" || track.id === undefined || track.id === null) {
      skipped += 1;
      continue;
    }
    tracks.push(toTrack(track));
  }
  // K9: a dropped record is counted and reported, not silently swallowed.
  if (skipped > 0) host.log.warn(`${skipped} search records skipped because they aren't tracks`);
  return tracks;
}

export function resolve_source(id) {
  const trackId = String(id ?? "").trim();
  if (trackId === "") throw new Error("the track ID is empty");

  let track;
  try {
    track = apiGet(`/tracks/${encodeURIComponent(trackId)}`);
  } catch (err) {
    // "Doesn't exist" is an answer, not an error.
    if (err instanceof StatusError && err.status === 404) return null;
    throw err;
  }
  if (track.streamable === false || track.policy === "BLOCK") return null;

  const transcoding = progressiveUrl(track);
  if (!transcoding) {
    // "I can't play it" and "it doesn't exist" are different diagnoses (K9). We
    // measured it: ~1% of the tracks are like this.
    throw new Error(
      "this track offers only HLS; the plugin doesn't decode HLS (~1% of the tracks are like this)",
    );
  }

  const resolved = getJson(`${transcoding}?${query({ client_id: resolveClientId() })}`);
  if (!resolved.url) throw new Error("SoundCloud returned no stream address");

  // The address is signed and time-limited — it isn't cached; it's resolved
  // again on every play.
  return { kind: "http_stream", url: resolved.url, headers: [] };
}

// --- covers (api 3, headshell D-076) -------------------------------------------------
//
// A track's `artwork_url` is its cover at 100 px (`…-large.jpg`); SoundCloud keeps
// the other sizes at the same address with another suffix, and `t500x500` exists
// for every upload. A track without artwork has `null` there. SoundCloud's pages
// then show the uploader's avatar — a portrait, not a cover: we say "none", and
// the app goes on to its own chain.

/** The cover's address at the size asked for: 500 px, or 100 when that is enough. */
function coverUrl(artworkUrl, size) {
  if (size <= 100) return artworkUrl;
  return artworkUrl.replace(/-large(\.\w+)$/, "-t500x500$1");
}

export function artwork(id, size) {
  const trackId = String(id ?? "").trim();
  if (trackId === "") throw new Error("the track ID is empty");

  let track;
  try {
    track = apiGet(`/tracks/${encodeURIComponent(trackId)}`);
  } catch (err) {
    // "Doesn't exist" is an answer, not an error.
    if (err instanceof StatusError && err.status === 404) return null;
    throw err;
  }
  if (!track.artwork_url) return null;

  const url = coverUrl(track.artwork_url, Number(size) || 500);
  let res;
  try {
    // `binary`: the image comes as base64 — read as text, it would be destroyed.
    res = host.http.request({ url, headers: HEADERS, binary: true });
  } catch (err) {
    throw new Error(`SoundCloud's cover could not be fetched: ${err.message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new StatusError(res.status, url);
  return { mime: res.headers["content-type"] ?? null, data: res.body };
}

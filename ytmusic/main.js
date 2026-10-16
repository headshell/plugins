// The YouTube Music provider plugin (api 7, D-048 → D-069 → D-076 → D-078 → D-086 → D-087 → D-088 → D-095).
//
// The same rules as the SoundCloud plugin: audio is never relayed (K3), and
// nothing circumvents DRM (D-026). It moved from Python to JS in D-069, and now
// **nothing has to be installed** on the user's machine: search goes through the
// engine's HTTP gate, the stream through the yt-dlp the engine installs — and the
// engine downloads yt-dlp's binary built for this platform, which carries its
// own Python inside it.
//
// ## The division of labour: search from InnerTube, the stream from InnerTube or yt-dlp
//
// All three were chosen by measuring (D-048, D-088):
//
// - **Search** goes to YouTube Music's own InnerTube endpoint. yt-dlp's search
//   output gives only `title` + `id` — no artist, no duration — and K6's fuzzy
//   match link doesn't work without them.
// - **The stream** is asked of InnerTube's `player` endpoint first, as the
//   visionOS client (the fast path, D-088). That client needs no JS player: its
//   addresses come with neither a signature to solve nor an `n` parameter.
//   yt-dlp itself does exactly this one call when it has no JS runtime — but it
//   took 4.5–5.5 s around it (1.1 s of it only to unpack itself), and the call
//   alone takes 0.2–0.5 s.
// - **yt-dlp stays as the fallback.** When the fast path fails for any reason —
//   YouTube retires the client, a bot wall a fresh visitor id doesn't pass, a
//   video it doesn't serve — yt-dlp is asked, and its words have the last say.
//   YouTube's signature/nsig work isn't this project's job; when it breaks,
//   yt-dlp gets updated, not us.
//
// **Covers** (api 3) come from InnerTube too: the `next` endpoint gives a song's
// square album art, up to 544 px, on `yt3.googleusercontent.com`.
//
// **Lyrics** (api 4) as well: the song's own, from its lyrics page — timed
// line by line when YouTube Music has the timing.
//
// **Similar songs** (api 6) too: the song's own radio — the `next` endpoint
// with the `RDAMVM<id>` playlist lists what YouTube Music would play after it.
// Only the song's id goes out; the app's taste never reaches this plugin.
//
// **Links** (api 7) open the song at a YouTube Music or YouTube link — a video
// that isn't on YouTube Music too: its id is a video id either way, and the
// stream comes the same way. Only song links for now; a playlist's waits.

//
// ## Two traps, both measured
//
// 1. **`bestaudio` can't be played.** The core's symphonia has no opus decoder
//    and no webm container; `bestaudio` picks opus/webm. The format is pinned to
//    m4a (AAC-LC).
// 2. **A plain GET is throttled.** The same address gives 32 KB/s on a plain
//    request and 8 MB/s with a `Range: bytes=0-` header — 250 times. The header
//    is passed to the core together with the stream source.

const INNERTUBE_URL = "https://music.youtube.com/youtubei/v1/search";
const INNERTUBE_NEXT_URL = "https://music.youtube.com/youtubei/v1/next";
const INNERTUBE_BROWSE_URL = "https://music.youtube.com/youtubei/v1/browse";
const WATCH_URL = "https://music.youtube.com/watch?v=";

// The InnerTube client context. No key needed (measured, D-048); the client name
// is WEB_REMIX because what we're searching is the YouTube Music catalog, not all
// of YouTube.
const INNERTUBE_CLIENT = {
  clientName: "WEB_REMIX",
  clientVersion: "1.20240101.01.00",
  hl: "en",
  gl: "US",
};
// The search filter: songs only. An unfiltered query also returns channel pages,
// playlists and "10-hour loop" videos.
const SONGS_FILTER = "EgWKAQIIAWoKEAoQCRADEAQQBQ==";

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// The best audio we can decode. The order matters: if there's no 140 (AAC-LC
// ~130 kbps), 139 (~49 kbps) is taken; if there's neither, an error is returned —
// opus is never picked silently.
const AUDIO_FORMAT = "140/139/bestaudio[ext=m4a]";
// The same choice for the fast path, which sees YouTube's own format numbers.
const AUDIO_ITAGS = [140, 139];

// The fast path's client (D-088): the one yt-dlp 2026.08.19 uses when it has no
// JS runtime (`_DEFAULT_JSLESS_CLIENTS`), with the same context it sends. When
// YouTube retires it, the fast path fails and yt-dlp carries on — take the new
// values from yt-dlp's `INNERTUBE_CLIENTS` then.
const INNERTUBE_PLAYER_URL = "https://music.youtube.com/youtubei/v1/player?prettyPrint=false";
const FAST_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const FAST_CLIENT = {
  clientName: "VISIONOS",
  clientVersion: "1.02",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  osName: "visionOS",
  osVersion: "26.5.23O471",
  userAgent: FAST_UA,
  hl: "en",
  gl: "US",
};
const FAST_CLIENT_NUMBER = "101";

// Where the visitor id is kept between sessions (`host.storage`).
const VISITOR_KEY = "visitor_data";

// The call's budget is 20 s. yt-dlp can spend 8-10 s solving signatures, and the
// self-contained binary unpacks itself into a temporary directory on every start;
// the budget must still stay below the call's, so the error comes *from us* and
// we can say why (K9).
const YTDLP_TIMEOUT_MS = 16000;

const DURATION_PATTERN = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/;

// --- InnerTube -------------------------------------------------------------------

/**
 * Posts to an InnerTube endpoint and returns the parsed answer. The web client
 * unless another is given (the lyrics' timing comes only to the mobile one).
 */
function innertube(url, body, what, client = INNERTUBE_CLIENT, userAgent = BROWSER_UA) {
  const payload = JSON.stringify({ context: { client: { ...client } }, ...body });
  let res;
  try {
    res = host.http.post(url, payload, {
      "Content-Type": "application/json",
      "User-Agent": userAgent,
      Origin: "https://music.youtube.com",
    });
  } catch (err) {
    throw new Error(`YouTube Music could not be reached: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`the YouTube Music ${what} returned ${res.status}; the InnerTube surface may have changed`);
  }
  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new Error(`YouTube Music gave an answer that isn't JSON: ${err.message}`);
  }
}

/** Calls YouTube Music's song search and returns the raw rows. */
function innertubeSearch(text, limit) {
  const document = innertube(INNERTUBE_URL, { query: text, params: SONGS_FILTER }, "search");
  return collectSongRows(document).slice(0, limit);
}

/**
 * Collects the song rows from inside the response.
 *
 * InnerTube's tree is deep and changes without warning; so instead of walking
 * the path step by step, we **search for** the `musicResponsiveListItemRenderer`
 * key. If the structure changes by a level, the search still works; if the key
 * itself disappears, zero rows come back and the caller reports it as "the
 * surface changed".
 *
 * **The order is kept.** The order YouTube gives is the relevance order, and
 * `limit` cuts it from the start. The children are pushed onto the stack **in
 * reverse**, so `pop()` gives them back in document order.
 */
function collectSongRows(document) {
  const rows = [];
  const stack = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
    } else if (node !== null && typeof node === "object") {
      const row = node.musicResponsiveListItemRenderer;
      if (row !== null && typeof row === "object") {
        rows.push(row);
        continue;
      }
      const values = Object.values(node);
      for (let i = values.length - 1; i >= 0; i -= 1) stack.push(values[i]);
    }
  }
  return rows;
}

/** The text runs inside `flexColumns[index]`. */
function columnRuns(row, index) {
  const column = row.flexColumns?.[index]?.musicResponsiveListItemFlexColumnRenderer;
  return column?.text?.runs ?? [];
}

/** The row's `videoId`. It can sit in two places; we look at both. */
function videoId(row) {
  const play =
    row.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer;
  const found = play?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (found) return found;
  for (const run of columnRuns(row, 0)) {
    const id = run.navigationEndpoint?.watchEndpoint?.videoId;
    if (id) return id;
  }
  return null;
}

/** `4:11` or `1:02:30` → milliseconds. `null` if not recognised. */
function parseDurationMs(text) {
  const matched = DURATION_PATTERN.exec(text.trim());
  if (!matched) return null;
  const [, hours, minutes, seconds] = matched;
  return (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
}

/**
 * Splits the second column into groups by the ` • ` separators.
 *
 * The observed form: `artist [• album] • duration`. Not every row has an album,
 * and the artist can be several runs (`vagabond`, `,`, `shilou.`, `&`, `vibe`).
 * That's why the text itself, not a fixed position, decides the separator.
 */
function splitMetadataRuns(runs) {
  const groups = [[]];
  for (const run of runs) {
    const text = run.text ?? "";
    if (text.trim() === "•") groups.push([]);
    else groups[groups.length - 1].push(text);
  }
  return groups.map((group) => group.join("").trim()).filter((group) => group !== "");
}

/**
 * Turns an InnerTube row into the contract's track shape.
 * Returns `null` when it can't — the caller **counts and reports** those (K9).
 */
function rowToTrack(row) {
  const id = videoId(row);
  if (!id) return null;
  const title = columnRuns(row, 0)
    .map((run) => run.text ?? "")
    .join("")
    .trim();
  if (!title) return null;

  let groups = splitMetadataRuns(columnRuns(row, 1));
  let durationMs = null;
  if (groups.length > 0) {
    durationMs = parseDurationMs(groups[groups.length - 1]);
    if (durationMs !== null) groups = groups.slice(0, -1);
  }
  const artist = groups[0] ?? "";
  const album = groups[1] ?? "";
  // A row without an artist can't enter fuzzy matching (K6). We drop it, but it
  // gets counted — better than making up an "Unknown artist".
  if (!artist) return null;

  const track = { id, artist, title, duration_ms: durationMs ?? 0 };
  if (album) track.album = album;
  return track;
}

// --- The fast path (D-088) ---------------------------------------------------------

// The visitor id the fast path sends. Without one, YouTube put up its bot wall
// for 9 tracks out of 9; with the one its own answer hands back, 9 out of 9
// passed (measured from a home address, D-088). Kept in the module for the
// session and in `host.storage` across sessions; `undefined` until it's read.
let visitorData;

function knownVisitor() {
  if (visitorData === undefined) visitorData = host.storage.get(VISITOR_KEY);
  return visitorData;
}

function rememberVisitor(value) {
  visitorData = value;
  host.storage.set(VISITOR_KEY, value);
}

function forgetVisitor() {
  visitorData = null;
  host.storage.remove(VISITOR_KEY);
}

/** One call to InnerTube's `player` endpoint as the fast path's client. */
function fastPlayer(video, visitor) {
  const client = { ...FAST_CLIENT };
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": FAST_UA,
    Origin: "https://music.youtube.com",
    "X-YouTube-Client-Name": FAST_CLIENT_NUMBER,
    "X-YouTube-Client-Version": FAST_CLIENT.clientVersion,
  };
  if (visitor) {
    client.visitorData = visitor;
    headers["X-Goog-Visitor-Id"] = visitor;
  }
  const body = JSON.stringify({
    context: { client },
    videoId: video,
    contentCheckOk: true,
    racyCheckOk: true,
  });
  const res = host.http.post(INNERTUBE_PLAYER_URL, body, headers);
  if (!res.ok) throw new Error(`the player endpoint returned ${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new Error(`the player endpoint gave an answer that isn't JSON: ${err.message}`);
  }
}

/**
 * Resolves a track's address without yt-dlp: one call, or two when the bot
 * wall hands back a fresh visitor id. Otherwise it throws with YouTube's own
 * reason, and the caller carries that reason into yt-dlp's attempt (K9).
 */
function fastResolve(video) {
  const visitor = knownVisitor();
  let answer = fastPlayer(video, visitor);
  const fresh = answer.responseContext?.visitorData;
  if (answer.playabilityStatus?.status === "LOGIN_REQUIRED" && fresh && fresh !== visitor) {
    // The bot wall's answer carries a visitor id of its own; asked again with
    // it, the wall let every measured track through.
    rememberVisitor(fresh);
    answer = fastPlayer(video, fresh);
  } else if (!visitor && fresh) {
    rememberVisitor(fresh);
  }

  const status = answer.playabilityStatus?.status ?? "no status";
  if (status !== "OK") {
    // A visitor id the wall still stops is no use next time either.
    if (status === "LOGIN_REQUIRED") forgetVisitor();
    const reason = answer.playabilityStatus?.reason;
    throw new Error(reason ? `${status}: ${reason}` : status);
  }
  const formats = answer.streamingData?.adaptiveFormats ?? [];
  for (const itag of AUDIO_ITAGS) {
    const format = formats.find((f) => f.itag === itag && typeof f.url === "string");
    if (format) return format.url;
  }
  // A format without an address carries a signature to solve: the client lost
  // what made it the fast path, and that work is yt-dlp's, not ours.
  const audio = formats
    .filter((f) => String(f.mimeType ?? "").startsWith("audio/"))
    .map((f) => (f.url ? `${f.itag}` : `${f.itag} without an address`));
  throw new Error(`no m4a audio with an address (audio formats: ${audio.join(", ") || "none"})`);
}

// --- yt-dlp ------------------------------------------------------------------

/**
 * Runs yt-dlp through the engine.
 *
 * The plugin **doesn't look for, install or update** yt-dlp (D-049, D-055):
 * which version, which platform, from where — the manifest's `requires` says,
 * and the engine installs it. If it isn't installed, the engine's own error says
 * what to do.
 */
function ytdlp(args) {
  return host.tools.run("yt-dlp", args, { timeoutMs: YTDLP_TIMEOUT_MS });
}

/** Resolves the audio format of a single track with yt-dlp. */
function ytdlpJson(video) {
  const args = ["--no-warnings", "--no-playlist", "-f", AUDIO_FORMAT, "-J"];
  // YouTube puts up a bot wall for data centre addresses (D-061), and yt-dlp
  // reads cookies only from a file. The engine writes the secret to a `0600`
  // temporary file and deletes it when the engine shuts down; if there's no
  // secret, it's `null` and yt-dlp runs without cookies — cookies aren't a
  // requirement but a way out.
  const cookies = host.secrets.file("cookies");
  if (cookies !== null) args.push("--cookies", cookies);
  args.push(WATCH_URL + video);

  const run = ytdlp(args);
  if (run.code !== 0) {
    // We pass yt-dlp's own message on as it is (D-048): let "Sign in to confirm
    // you're not a bot" show instead of "something went wrong".
    const lines = run.stderr.trim().split("\n").filter((line) => line.trim() !== "");
    throw new Error(`yt-dlp: ${lines[lines.length - 1] ?? `exit code ${run.code}`}`);
  }
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    throw new Error(`yt-dlp gave an answer that isn't JSON: ${err.message}`);
  }
}

/**
 * Returns the chosen format.
 *
 * When `-f` is given, yt-dlp gives the address at the top level as `url`; if
 * several streams are merged, under `requested_formats`. We look at both and
 * make sure we didn't fall onto a silent video stream. The filter goes through
 * `acodec === "none"`: so as not to reject valid audio in a version that doesn't
 * send the field at all.
 */
function pickAudio(document) {
  const candidates = document.requested_formats ?? [document];
  return candidates.find((c) => c.acodec !== "none" && c.url) ?? null;
}

// --- the contract ------------------------------------------------------------------

/**
 * Probes three independent things separately: the search endpoint, the fast
 * path and yt-dlp. A single "doesn't work" answer would hide which of them
 * broke (K9). The fast path failing doesn't make the plugin unreachable —
 * yt-dlp is asked instead, only slower — so it's a note, not a verdict.
 */
export function health() {
  const notes = [];
  let reachable = true;

  let probe = null;
  try {
    const rows = innertubeSearch("a", 1);
    notes.push(`the InnerTube search returned ${rows.length} rows`);
    probe = rows.length > 0 ? videoId(rows[0]) : null;
  } catch (err) {
    reachable = false;
    notes.push(`search: ${err.message}`);
  }

  if (probe !== null) {
    try {
      fastResolve(probe);
      notes.push("the fast path resolved a stream");
    } catch (err) {
      notes.push(`the fast path: ${err.message} (yt-dlp is asked instead)`);
    }
  }

  try {
    const run = ytdlp(["--version"]);
    if (run.code === 0) {
      notes.push(`yt-dlp ${run.stdout.trim()} (engine, ${host.platform})`);
    } else {
      reachable = false;
      notes.push(`yt-dlp --version exit code ${run.code}`);
    }
  } catch (err) {
    reachable = false;
    notes.push(`yt-dlp: ${err.message}`);
  }

  // The catalog size changes with the query; "I don't know" is better than a
  // wrong number.
  return { reachable, track_count: null, detail: notes.join("; ") };
}

export function search(text, limit) {
  const q = String(text ?? "").trim();
  if (q === "") return [];
  const size = Math.max(1, Math.min(Number(limit) || 20, 100));

  const rows = innertubeSearch(q, size);
  if (rows.length === 0) {
    // Zero rows can be two things: no results, or the surface changed. We don't
    // tell them apart, but we don't stay silent either.
    host.log.info(`no song rows came for '${q}'`);
    return [];
  }

  const tracks = [];
  let skipped = 0;
  for (const row of rows) {
    const track = rowToTrack(row);
    if (track === null) skipped += 1;
    else tracks.push(track);
  }
  // K9: a dropped record is counted and reported, not silently swallowed.
  if (skipped > 0) {
    host.log.warn(`${skipped} search rows could not be converted (missing ID/artist/title)`);
  }
  return tracks;
}

// --- covers (api 3, headshell D-076) -------------------------------------------------
//
// The `next` endpoint (what the player asks when a song starts) carries the song
// in its queue panel, with its thumbnails: for a song — not a video — they are
// the album's square art at 60 … 544 px (measured 2026-09-26). A video's
// thumbnail is a 16:9 frame on `i.ytimg.com`, not a cover: that is "none", and
// the app goes on to its own chain.

const COVER_HOSTS = ["yt3.googleusercontent.com", "lh3.googleusercontent.com"];

/** The thumbnails `next` gives for `video`, or `null` when the song isn't in the answer. */
function nextThumbnails(video) {
  const document = innertube(INNERTUBE_NEXT_URL, { videoId: video, isAudioOnly: true }, "player queue");
  const stack = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else if (node !== null && typeof node === "object") {
      const panel = node.playlistPanelVideoRenderer;
      if (panel?.videoId === video) return panel.thumbnail?.thumbnails ?? [];
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return null;
}

/** The smallest square cover at least `size` wide, or the largest there is. */
function pickCover(thumbnails, size) {
  const covers = thumbnails
    .filter((t) => typeof t.url === "string" && COVER_HOSTS.some((h) => t.url.startsWith(`https://${h}/`)))
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  if (covers.length === 0) return null;
  return covers.find((t) => (t.width ?? 0) >= size) ?? covers[covers.length - 1];
}

export function artwork(id, size) {
  const video = String(id ?? "").trim();
  if (video === "") throw new Error("the track ID is empty");

  const thumbnails = nextThumbnails(video);
  if (thumbnails === null) return null;
  const cover = pickCover(thumbnails, Number(size) || 500);
  if (cover === null) return null;

  let res;
  try {
    // `binary`: the image comes as base64 — read as text, it would be destroyed.
    res = host.http.request({ url: cover.url, headers: { "User-Agent": BROWSER_UA }, binary: true });
  } catch (err) {
    throw new Error(`YouTube Music's cover could not be fetched: ${err.message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`YouTube Music's cover returned HTTP ${res.status}`);
  return { mime: res.headers["content-type"] ?? null, data: res.body };
}

// --- lyrics (api 4, headshell D-078) ------------------------------------------------
//
// The song's own lyrics at YouTube Music: the same video that plays, so their
// timing is the recording's — the app takes them over any other source.
//
// The `next` endpoint names the song's lyrics page (a tab whose page type is
// `MUSIC_PAGE_TYPE_TRACK_LYRICS`); `browse` gives the page. Measured
// 2026-09-26: asked as the mobile app, the page carries timed lines
// (`timedLyricsModel`: a start in milliseconds per line, "♪" for a pause), from
// LyricFind or Musixmatch; asked as the web client, the words alone. The mobile
// answer was not the same on every call — once a line came without its start —
// so the lines are checked, and without enough of them the words alone are
// taken. "Lyrics not available" (an instrumental, a song without them) is
// `null`: the app goes on to LRCLIB.

const IOS_MUSIC_CLIENT = { clientName: "IOS_MUSIC", clientVersion: "7.21.1", hl: "en", gl: "US" };
const IOS_MUSIC_UA = "com.google.ios.youtubemusic/7.21.1 (iPhone14,3; U; CPU iOS 17_5 like Mac OS X)";

/** The first value under `key` anywhere in `document`, or `null`. */
function findKey(document, key) {
  const stack = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else if (node !== null && typeof node === "object") {
      if (node[key] !== undefined) return node[key];
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return null;
}

/** The `browseId` of the song's lyrics page, or `null` when it has none. */
function lyricsPage(video) {
  const document = innertube(INNERTUBE_NEXT_URL, { videoId: video, isAudioOnly: true }, "player queue");
  const stack = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else if (node !== null && typeof node === "object") {
      const browse = node.tabRenderer?.endpoint?.browseEndpoint;
      const page = browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      if (page === "MUSIC_PAGE_TYPE_TRACK_LYRICS" && typeof browse.browseId === "string") return browse.browseId;
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return null;
}

/** `[mm:ss.xxx]` — the millisecond kept, the core's parser reads three digits. */
function lrcStamp(ms) {
  const total = Math.max(0, Math.floor(ms));
  const minutes = String(Math.floor(total / 60000)).padStart(2, "0");
  const seconds = String(Math.floor((total % 60000) / 1000)).padStart(2, "0");
  const millis = String(total % 1000).padStart(3, "0");
  return `[${minutes}:${seconds}.${millis}]`;
}

function runsText(runs) {
  return (runs ?? []).map((run) => run.text ?? "").join("");
}

// --- similar songs (api 6, D-087) ---------------------------------------------
//
// The song's radio: `next` with the playlist `RDAMVM` + id answers with a queue
// panel of up to 50 songs, the seed first (measured 2026-10-03: "Alison" →
// "When the Sun Hits", "Weird Fishes / Arpeggi", "when you sleep", …). Each
// row's byline is `artist • album • year`.

/** The queue panel's rows, in the panel's order. */
function panelRows(node, out) {
  if (Array.isArray(node)) {
    for (const child of node) panelRows(child, out);
  } else if (node !== null && typeof node === "object") {
    if (node.playlistPanelVideoRenderer) {
      out.push(node.playlistPanelVideoRenderer);
      return out;
    }
    for (const child of Object.values(node)) panelRows(child, out);
  }
  return out;
}

/** A video's view count where a song's album would stand. */
const VIEWS = /^[\d.,]+\s*[KMB]?\s+views?$/i;

/** A queue panel row as the contract's track, or `null` when it can't be one. */
function panelToTrack(panel) {
  const id = panel.videoId;
  const title = runsText(panel.title?.runs).trim();
  const groups = splitMetadataRuns(panel.longBylineText?.runs ?? panel.shortBylineText?.runs ?? []);
  const artist = groups[0] ?? "";
  if (!id || !title || !artist) return null;
  const track = { id, artist, title, duration_ms: parseDurationMs(runsText(panel.lengthText?.runs)) ?? 0 };
  // A song's byline names its album; a video's names its views ("444M views")
  // in the same place — not an album.
  if (groups[1] && !/^\d{4}$/.test(groups[1]) && !VIEWS.test(groups[1])) track.album = groups[1];
  return track;
}

export function related(id, limit) {
  const video = String(id ?? "").trim();
  if (!video) return [];
  const document = innertube(
    INNERTUBE_NEXT_URL,
    { videoId: video, playlistId: `RDAMVM${video}`, isAudioOnly: true },
    "song radio",
  );
  const seen = new Set([video]);
  const tracks = [];
  let skipped = 0;
  for (const panel of panelRows(document, [])) {
    if (seen.has(panel.videoId)) continue;
    seen.add(panel.videoId);
    const track = panelToTrack(panel);
    if (track) tracks.push(track);
    else skipped += 1;
    if (tracks.length >= limit) break;
  }
  if (skipped > 0) host.log.warn(`${skipped} radio rows could not be converted (missing ID/artist/title)`);
  return tracks;
}

export function lyrics(id) {
  const video = String(id ?? "").trim();
  if (video === "") throw new Error("the track ID is empty");

  const page = lyricsPage(video);
  if (page === null) return null;

  // The timed lines, asked as the mobile app.
  const timed = findKey(
    innertube(INNERTUBE_BROWSE_URL, { browseId: page }, "lyrics page", IOS_MUSIC_CLIENT, IOS_MUSIC_UA),
    "timedLyricsModel",
  );
  const all = timed?.lyricsData?.timedLyricsData ?? [];
  const lines = all.filter((line) => Number.isFinite(Number(line?.cueRange?.startTimeMilliseconds)));
  if (lines.length > 0 && lines.length * 2 >= all.length) {
    const synced = lines
      .map((line) => {
        const words = String(line.lyricLine ?? "").trim();
        // A pause is an empty line in LRC.
        return `${lrcStamp(Number(line.cueRange.startTimeMilliseconds))}${words === "♪" ? "" : words}`;
      })
      .join("\n");
    return { synced, attribution: timed.lyricsData.sourceMessage ?? null };
  }
  if (all.length > 0) {
    host.log.warn(`${all.length - lines.length} of ${all.length} timed lyric lines came without a start; taking the words alone`);
  }

  // The words alone, as the web client shows them.
  const shelf = findKey(innertube(INNERTUBE_BROWSE_URL, { browseId: page }, "lyrics page"), "musicDescriptionShelfRenderer");
  const words = runsText(shelf?.description?.runs);
  if (words.trim() === "") return null;
  return { plain: words, attribution: runsText(shelf?.footer?.runs).trim() || null };
}

export function resolve_source(id) {
  const video = String(id ?? "").trim();
  if (video === "") throw new Error("the track ID is empty");

  let url = null;
  let fastFailure = null;
  try {
    url = fastResolve(video);
  } catch (err) {
    fastFailure = err.message;
    host.log.info(`the fast path did not resolve ${video} (${fastFailure}); asking yt-dlp`);
  }

  if (url === null) {
    let chosen;
    try {
      chosen = pickAudio(ytdlpJson(video));
    } catch (err) {
      // Both said no: yt-dlp's words first (D-048), the fast path's after them.
      throw new Error(`${err.message} (the fast path: ${fastFailure})`);
    }
    if (chosen === null) {
      // "I can't play it" and "it doesn't exist" are different diagnoses (K9).
      throw new Error(
        `yt-dlp gave no audio format we can decode for this track (asked for: ${AUDIO_FORMAT}; the fast path: ${fastFailure})`,
      );
    }
    url = chosen.url;
  }
  return {
    kind: "http_stream",
    url,
    // Measured (D-048): without this header the same address gives 32 KB/s, with
    // it 8 MB/s. Not decryption — a standard range request the server answers
    // with 206.
    headers: [{ name: "Range", value: "bytes=0-" }],
  };
}

// --- links (api 7, headshell D-095) -------------------------------------------------
//
// The manifest's templates hand over what stood in `{id}`: a video id, from a
// YouTube Music, a YouTube or a youtu.be link alike. The song's name comes from
// the `next` endpoint's queue panel — a video YouTube Music doesn't list as a
// song gets one too, its title and its channel — and the player endpoint names
// it when the panel doesn't.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The track `next` names for `video`, asked as audio first and then as a video. */
function nextTrack(video) {
  for (const isAudioOnly of [true, false]) {
    const document = innertube(INNERTUBE_NEXT_URL, { videoId: video, isAudioOnly }, "player queue");
    const panel = panelRows(document, []).find((row) => row.videoId === video);
    const track = panel ? panelToTrack(panel) : null;
    if (track) return track;
  }
  return null;
}

/** The track the player endpoint names for `video`, or `null` when it can't be played. */
function playerTrack(video) {
  const details = fastPlayer(video, knownVisitor()).videoDetails;
  if (!details?.title || !details?.author) return null;
  return {
    id: video,
    artist: String(details.author).replace(/ - Topic$/, ""),
    title: String(details.title),
    duration_ms: (Number(details.lengthSeconds) || 0) * 1000,
  };
}

export function link(id, template) {
  const video = String(id ?? "").trim();
  if (!VIDEO_ID.test(video)) {
    throw new Error(`"${video}" isn't a YouTube video id (eleven letters, digits, - or _) — from ${template}`);
  }
  const track = nextTrack(video) ?? playerTrack(video);
  return track ? [track] : [];
}

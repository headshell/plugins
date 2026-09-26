// The YouTube Music provider plugin (api 3, D-048 → D-069 → D-076).
//
// The same rules as the SoundCloud plugin: audio is never relayed (K3), and
// nothing circumvents DRM (D-026). It moved from Python to JS in D-069, and now
// **nothing has to be installed** on the user's machine: search goes through the
// engine's HTTP gate, the stream through the yt-dlp the engine installs — and the
// engine downloads yt-dlp's binary built for this platform, which carries its
// own Python inside it.
//
// ## The division of labour: search from InnerTube, the stream from yt-dlp
//
// Both were chosen by measuring (D-048):
//
// - **Search** goes to YouTube Music's own InnerTube endpoint. yt-dlp's search
//   output gives only `title` + `id` — no artist, no duration — and K6's fuzzy
//   match link doesn't work without them.
// - **The stream** goes to yt-dlp. YouTube's signature/nsig work isn't this
//   project's job; when it breaks, yt-dlp gets updated, not us.
//
// **Covers** (api 3) come from InnerTube too: the `next` endpoint gives a song's
// square album art, up to 544 px, on `yt3.googleusercontent.com`.
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

// The call's budget is 20 s. yt-dlp can spend 8-10 s solving signatures, and the
// self-contained binary unpacks itself into a temporary directory on every start;
// the budget must still stay below the call's, so the error comes *from us* and
// we can say why (K9).
const YTDLP_TIMEOUT_MS = 16000;

const DURATION_PATTERN = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/;

// --- InnerTube -------------------------------------------------------------------

/** Posts to an InnerTube endpoint and returns the parsed answer. */
function innertube(url, body, what) {
  const payload = JSON.stringify({ context: { client: { ...INNERTUBE_CLIENT } }, ...body });
  let res;
  try {
    res = host.http.post(url, payload, {
      "Content-Type": "application/json",
      "User-Agent": BROWSER_UA,
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
 * Probes two independent things separately: the search endpoint and yt-dlp. A
 * single "doesn't work" answer would hide which of them broke (K9).
 */
export function health() {
  const notes = [];
  let reachable = true;

  try {
    const rows = innertubeSearch("a", 1);
    notes.push(`the InnerTube search returned ${rows.length} rows`);
  } catch (err) {
    reachable = false;
    notes.push(`search: ${err.message}`);
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

export function resolve_source(id) {
  const video = String(id ?? "").trim();
  if (video === "") throw new Error("the track ID is empty");

  const chosen = pickAudio(ytdlpJson(video));
  if (chosen === null) {
    // "I can't play it" and "it doesn't exist" are different diagnoses (K9).
    throw new Error(
      `yt-dlp gave no audio format we can decode for this track (asked for: ${AUDIO_FORMAT})`,
    );
  }
  return {
    kind: "http_stream",
    url: chosen.url,
    // Measured (D-048): without this header the same address gives 32 KB/s, with
    // it 8 MB/s. Not decryption — a standard range request the server answers
    // with 206.
    headers: [{ name: "Range", value: "bytes=0-" }],
  };
}

// The YouTube provider plugin (api 6, headshell D-086, D-087 — it names no similar songs).
//
// It finds music videos and nothing else: the app plays them in YouTube's own
// player — the official IFrame embed — so no stream is resolved, nothing is
// downloaded, and there is no yt-dlp. YouTube's rules for that player are the
// app's to keep (the player stays visible while it plays, nothing is laid over
// it); this plugin only answers "which video".
//
// ## Search: YouTube Music's video search
//
// The same InnerTube endpoint the YouTube Music plugin asks, with the
// **videos** filter instead of the songs one (measured 2026-10-02): a row
// carries the video's title in its first column and `artist • views •
// duration` in its second — the artist and the duration K6's fuzzy match
// needs, which a plain YouTube search does not give as fields.
//
// A video's title is not a song's title: `Daft Punk - Get Lucky (Official
// Video) feat. Pharrell Williams`. The artist prefix and the "official video"
// labels are taken off, so the app's matching compares songs with songs. What
// is left is a guess, and the app weighs it as one.

const INNERTUBE_URL = "https://music.youtube.com/youtubei/v1/search";

const INNERTUBE_CLIENT = {
  clientName: "WEB_REMIX",
  clientVersion: "1.20240101.01.00",
  hl: "en",
  gl: "US",
};
// The search filters. Videos first; when none come, songs — a song row's id is
// a video too (its "art track"), which the player plays as well.
const VIDEOS_FILTER = "EgWKAQIQAWoKEAoQCRADEAQQBQ==";
const SONGS_FILTER = "EgWKAQIIAWoKEAoQCRADEAQQBQ==";

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DURATION_PATTERN = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/;
// A YouTube video id: eleven URL-safe base64 characters. The app checks it
// again; checking here means a broken row is dropped and counted, not handed on.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// The labels a video's title carries that a song's does not.
const VIDEO_LABELS =
  /\s*[([](?:official\s+)?(?:music\s+|lyrics?\s+|hd\s+|4k\s+)?(?:video|audio|visuali[sz]er|mv|clip|lyrics?)(?:\s+(?:hd|4k))?[)\]]/gi;
const PLAIN_LABELS = /\s*[([](?:hd|4k|hq|remastered(?:\s+\d{4})?)[)\]]/gi;

// --- InnerTube -----------------------------------------------------------------

function innertubeSearch(text, filter) {
  const payload = JSON.stringify({
    context: { client: { ...INNERTUBE_CLIENT } },
    query: text,
    params: filter,
  });
  let res;
  try {
    res = host.http.post(INNERTUBE_URL, payload, {
      "Content-Type": "application/json",
      "User-Agent": BROWSER_UA,
      Origin: "https://music.youtube.com",
    });
  } catch (err) {
    throw new Error(`YouTube could not be reached: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`the YouTube search returned ${res.status}; the InnerTube surface may have changed`);
  }
  let document;
  try {
    document = JSON.parse(res.body);
  } catch (err) {
    throw new Error(`YouTube gave an answer that isn't JSON: ${err.message}`);
  }
  return collectRows(document);
}

/**
 * The result rows, in document order — the relevance order. The key is
 * searched for rather than walked to: the tree changes depth without warning.
 */
function collectRows(document) {
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

function columnRuns(row, index) {
  const column = row.flexColumns?.[index]?.musicResponsiveListItemFlexColumnRenderer;
  return column?.text?.runs ?? [];
}

function videoId(row) {
  const play = row.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer;
  const found = play?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (found) return found;
  for (const run of columnRuns(row, 0)) {
    const id = run.navigationEndpoint?.watchEndpoint?.videoId;
    if (id) return id;
  }
  return null;
}

function parseDurationMs(text) {
  const matched = DURATION_PATTERN.exec(text.trim());
  if (!matched) return null;
  const [, hours, minutes, seconds] = matched;
  return (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
}

/** `artist • 878M views • 4:09` → `["artist", "878M views", "4:09"]`. */
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
 * A video's title as a song's: `Daft Punk - Get Lucky (Official Video)` with
 * the artist `Daft Punk` → `Get Lucky`. The prefix is taken off only when it is
 * the artist — `AC/DC - Live` by a fan channel keeps its dash.
 */
function songTitle(title, artist) {
  let text = title.replace(VIDEO_LABELS, "").replace(PLAIN_LABELS, "").trim();
  const dash = text.search(/\s[-–—]\s/);
  if (dash > 0) {
    const before = text.slice(0, dash).trim().toLowerCase();
    const who = artist.trim().toLowerCase();
    if (who !== "" && (before === who || before.includes(who) || who.includes(before))) {
      text = text.slice(dash + 3).trim();
    }
  }
  return text === "" ? title.trim() : text;
}

/** A row in the contract's shape, or `null` — the caller counts those (K9). */
function rowToTrack(row) {
  const id = videoId(row);
  if (!id || !VIDEO_ID.test(id)) return null;
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
  // A video row says how often it was watched; that is not an album.
  groups = groups.filter((group) => !/\bviews?$/i.test(group));
  const artist = groups[0] ?? "";
  if (!artist) return null;

  const track = { id, artist, title: songTitle(title, artist), duration_ms: durationMs ?? 0 };
  const album = groups[1];
  if (album) track.album = album;
  return track;
}

function toTracks(rows) {
  const tracks = [];
  let skipped = 0;
  for (const row of rows) {
    const track = rowToTrack(row);
    if (track === null) skipped += 1;
    else tracks.push(track);
  }
  if (skipped > 0) {
    host.log.warn(`${skipped} search rows could not be converted (missing ID/artist/title)`);
  }
  return tracks;
}

// --- the contract ------------------------------------------------------------------

export function health() {
  try {
    const rows = innertubeSearch("a", VIDEOS_FILTER);
    return { reachable: true, track_count: null, detail: `the InnerTube video search returned ${rows.length} rows` };
  } catch (err) {
    return { reachable: false, track_count: null, detail: `search: ${err.message}` };
  }
}

export function search(text, limit) {
  const q = String(text ?? "").trim();
  if (q === "") return [];
  const size = Math.max(1, Math.min(Number(limit) || 20, 100));

  let tracks = toTracks(innertubeSearch(q, VIDEOS_FILTER));
  if (tracks.length === 0) {
    host.log.info(`no video rows came for '${q}'; asking for songs`);
    tracks = toTracks(innertubeSearch(q, SONGS_FILTER));
  }
  return tracks.slice(0, size);
}

/**
 * The video to show: the id itself. YouTube's player plays it; the app checks
 * the id's shape, and a video its owner keeps off other sites is reported by
 * the player when it refuses — the app moves on to the next match then.
 */
export function resolve_video(id) {
  const video = String(id ?? "").trim();
  if (!VIDEO_ID.test(video)) throw new Error(`'${video}' is not a YouTube video id`);
  return { kind: "youtube", video_id: video };
}

// --- covers ------------------------------------------------------------------------
//
// The video's own thumbnail: the largest 16:9 frame without bars. `maxresdefault`
// (1280×720) is not made for every video; `mqdefault` (320×180) always is.

const THUMBNAILS = ["maxresdefault", "mqdefault"];

export function artwork(id) {
  const video = String(id ?? "").trim();
  if (!VIDEO_ID.test(video)) throw new Error(`'${video}' is not a YouTube video id`);
  for (const name of THUMBNAILS) {
    let res;
    try {
      res = host.http.request({
        url: `https://i.ytimg.com/vi/${video}/${name}.jpg`,
        headers: { "User-Agent": BROWSER_UA },
        binary: true,
      });
    } catch (err) {
      throw new Error(`the video's thumbnail could not be fetched: ${err.message}`);
    }
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`the video's thumbnail returned HTTP ${res.status}`);
    return { mime: res.headers["content-type"] ?? "image/jpeg", data: res.body };
  }
  return null;
}

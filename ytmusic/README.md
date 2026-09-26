# YouTube Music

Searches YouTube Music (InnerTube) and plays the m4a stream it resolves with
yt-dlp.

**You don't install yt-dlp, and no Python is needed** — the plugin declares yt-dlp
per platform in its manifest, and the engine downloads your platform's
self-contained binary (~40 MB) and verifies its sha256 (headshell D-069).

```bash
headshell plugin install ytmusic    # downloads the plugin and yt-dlp, verifies both
headshell plugin approve ytmusic    # shows the permissions and what the engine downloads
headshell provider test ytmusic     # should write "available" + the yt-dlp version
headshell play "nujabes aruarian dance"
```

**Covers:** the song's album art, from InnerTube's `next` endpoint (square, up to
544 px, on `yt3.googleusercontent.com` — the permission list names it). A video
that isn't a song has only a 16:9 frame; that gives no cover, and the app goes on
to its own chain.

**NOTE:** yt-dlp isn't a script the engine jails but a separate program: its network
traffic isn't limited by this plugin's permission list. The approval screen writes
this separately on the `engine` line.

The declared platforms: Linux x86_64/aarch64 (glibc and musl), macOS (a universal
binary, Intel + Apple Silicon), Windows x86_64/x86/ARM64. **yt-dlp doesn't publish a
single-file release for 32-bit ARM Linux (`linux-arm`) or 32-bit x86 Linux**, and
there's no release at all for the BSDs. There the plugin **doesn't load**, and
`headshell plugin list` says "no release for this platform".

On data centre addresses YouTube can put up a bot wall (headshell D-061). If you
give cookies, they're passed to yt-dlp as a file and deleted when the engine shuts
down:

```bash
headshell secret set plugin:ytmusic cookies    # the contents of a Netscape-format cookie file
```

## The yt-dlp version

**This repository pins the version** (headshell D-055), and that has a price: when
YouTube breaks yt-dlp, the user can't get out of it by updating with their own
package manager; they wait for a new version to be published here —
`headshell plugin update` brings it and downloads the new binary. The update output
writes separately that the tool changed.

When updating, take **every platform's** hash from the `SHA2-256SUMS` file yt-dlp
publishes, and raise the plugin's `version`.

**Known limits**, all three measured:

- **The audio is m4a (AAC-LC, ~130 kbps).** headshell's symphonia has neither an
  opus decoder nor a webm container; lower quality that plays was chosen over
  higher quality that doesn't.
- **The stream is fetched with a `Range: bytes=0-` header.** Without this header
  the same address gives 32 KB/s; with it, 8 MB/s.
- **yt-dlp has started to want a JS runtime.** Version 2026.08.19 says "JS runtimes:
  none" and carries on with YouTube resolution without a JS runtime, but warns that
  this is **deprecated** (measured, headshell D-069). When that road closes, the
  engine will have to download a JS runtime too, through the same `requires`
  mechanism.

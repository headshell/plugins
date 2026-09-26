# SoundCloud

Searches and plays SoundCloud. You don't need to install anything.

```bash
headshell plugin install soundcloud
headshell plugin approve soundcloud
headshell provider test soundcloud     # should say "available"
headshell play "nujabes aruarian dance"
```

A `client_id` **isn't asked for**: the plugin discovers one itself from
SoundCloud's web client and caches it in `host.storage`. If you have your own key,
it's used, and discovery is never attempted:

```bash
headshell secret set plugin:soundcloud client_id
```

`headshell provider test soundcloud` writes which source was used
(`secret` / `cache` / `discovery`) — so that an install working with a wrong key
doesn't silently look right (headshell D-043).

**Covers:** the track's own artwork, at 500 px. A track without artwork gives none
(SoundCloud shows the uploader's avatar there, which isn't a cover), and the app
goes on to its own chain — MusicBrainz and the Cover Art Archive, when it's online.

**Lyrics:** SoundCloud keeps none. The manifest says so (`"lyrics": false`), and
the app asks LRCLIB for a track's lyrics itself (headshell D-078).

**Known limits**, both deliberate:

- **`progressive` (plain HTTP MP3) only.** Measured: 99% of the tracks have it. The
  remaining 1% offer only HLS and get an explicit error.
- **Tracks labelled `[preview]` are 30 seconds long.** SoundCloud's `SNIP` policy;
  the full track needs a subscription.

Discovery relies on an undocumented path and **can break without warning**. If it
breaks, the plugin tells you to give your own `client_id`.

Permissions: `soundcloud.com`, `api-v2.soundcloud.com`, `*.sndcdn.com` (the web
client's JS assets, the audio stream and the covers are under this domain).

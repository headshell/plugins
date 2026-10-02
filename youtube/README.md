# YouTube

Finds music videos on YouTube and hands them to the app's **official YouTube
player** — the IFrame embed, from `youtube-nocookie.com`. Nothing is downloaded,
no stream is resolved and there is no yt-dlp: YouTube plays the video itself,
with its own ads and its own counting (headshell D-086).

```bash
headshell plugin install youtube
headshell plugin approve youtube
headshell provider use youtube --for video   # videos for your songs come from here
headshell video "Daft Punk - Get Lucky"      # what the app's music/video switch would show
```

**Videos for your songs.** Chosen for videos, it is searched with a song's
artist and title whenever you switch the now-playing view to the video — the
song can come from anywhere (your files, a server, another service). The app
weighs each row against the song and leaves out a cover, a live take or
another song, then plays the best match from the second the music was at.

**As a music source.** Chosen as the main or music source, its tracks are
videos only: they play in the app's window (the record turns, the video shows
in a corner of the turntable), and the CLI passes them by, counted.

**YouTube's rules are the app's to keep:** the player stays on screen while it
plays (never behind another view), nothing is laid over it, it is never smaller
than 200 × 200. The plugin only answers "which video".

**Search** goes to YouTube Music's own search endpoint (InnerTube) with its
videos filter: a row there carries the artist and the length as fields, which
the app's matching needs. A video title's labels — `(Official Video)`, the
artist prefix — are taken off so a song is compared with a song.

**Covers:** the video's own thumbnail from `i.ytimg.com`, the largest one
without bars.

Permissions: `music.youtube.com` (search), `i.ytimg.com` (thumbnails).

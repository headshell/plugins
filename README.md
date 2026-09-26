# headshell plugins

The plugin catalog of [headshell](https://github.com/headshell/headshell). The
app reads its plugin list from the [`index.json`](index.json) at the root of this
repository, and installs and updates plugins from here (D-071).

<sub><b>English</b> · <a href="README.tr.md">Türkçe</a></sub>

| Plugin | What it does | What it needs |
|---|---|---|
| [`soundcloud`](soundcloud/) | Searches and plays SoundCloud, gives the tracks' covers | nothing |
| [`ytmusic`](ytmusic/) | Searches YouTube Music, plays with yt-dlp, gives the songs' album art | yt-dlp (the engine downloads it and verifies its sha256) |

Plugins are written in JavaScript and run in the QuickJS engine embedded in
headshell: no Python, Node or other runtime is needed. Every plugin declares the
addresses it will connect to, and the declaration **is enforced**.

## Installing

```bash
headshell plugin catalog              # what's available, what's installed, what can be updated
headshell plugin install soundcloud   # downloads it and verifies every file's sha256
headshell plugin approve soundcloud   # approve its permissions — an installed plugin waits for approval
headshell plugin update               # updates the ones installed from the catalog
headshell plugin remove soundcloud    # removes it and forgets the approval
```

On the desktop: **plugins → catalog → fetch the catalog**.

The catalog is read only by these commands; the app doesn't go to the network at
startup or in the background. For another catalog (a fork, a mirror),
`HEADSHELL_PLUGIN_INDEX=<address>`.

## How it works

- **Every plugin is a directory:** `<name>/plugin.json` and its script. How to
  write one is in the main repository:
  [the plugin writing guide](https://github.com/headshell/headshell/blob/master/docs/writing-plugins.md).
- **`index.json` is generated, not written by hand.** `headshell plugin index .`
  passes every manifest through the validation the app applies on installation,
  computes the files' sha256 and writes the index. The index carries the manifest
  itself: the permissions shown in the catalog are the permissions of what gets
  installed.
- **File addresses are pinned to the version tag:** `<name>-<version>`, for
  example `soundcloud-0.2.1`. The index sits on `main` and always gives the current
  list; the files it points to never change. Since GitHub's raw content cache holds
  for five minutes, an address pinned to `main` could pair the new index with the
  old file while a new version was being published.
- **The client trusts nothing blindly:** it verifies every file against the hash in
  the index and compares the downloaded `plugin.json` with what the index shows; if
  either doesn't match, it writes nothing to disk. An installed plugin doesn't run
  until the user approves it.
- **It never writes over a plugin installed or changed by hand.** Every plugin
  installed from the catalog has an origin record (`origin.json`) in its
  directory; an update touches only a plugin whose files are the same as that
  record.

## Publishing a new version

```bash
# 1. change the plugin, raise "version" in plugin.json
# 2. regenerate the index (the template is read from index.json)
headshell plugin index .
# 3. commit and tag the version
git commit -am "soundcloud 0.2.2: …"
git tag soundcloud-0.2.2
# 4. push the two TOGETHER
git push origin main soundcloud-0.2.2
```

The tag has to go together with the commit: the index points at the new tag, and
if the tag doesn't exist, installation says `file not found (HTTP 404)`.

A version's tag **is never moved.** Installed copies recorded that version's hash;
publishing different files under the same version would make them say "changed
locally". A fix is always a new version.

CI checks three things on every push: is the index up to date
(`plugin index --check`), does every version's tag exist and are its files the same
as that tag's, and can every plugin on `main` really be installed from the
published catalog.

## Adding a plugin to the catalog

Open a PR: a new `<name>/` directory (`plugin.json` + the script) and a regenerated
`index.json`. The rules:

- **Name:** lowercase ASCII letters, digits, `-`, `_`, `.`; it starts with a letter
  or a digit. The directory name and the `name` in `plugin.json` are the same.
- **`version` is required.** That's what catches an update.
- **Permissions as narrow as possible.** The user reads them on the approval
  screen, and the plugin can't connect to any address it didn't declare.
- **No installing on its own.** If a tool is needed, it's declared with
  `requires`: a pinned version, address and sha256 per platform. The engine does the
  download; no root is asked for (headshell D-049, D-055).

The maintainer who merges pushes the tag.

## License

MIT OR Apache-2.0 — like headshell itself.

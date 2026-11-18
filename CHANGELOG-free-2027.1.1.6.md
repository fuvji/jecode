# jetcode Free 2027.1.1.6

## Fixes

- **App no longer hangs on "Starting…"** — the brand check called `__dirname`
  in the ESM main bundle, which is undefined. The ready chain rejected before
  the first window was created: no renderer, no logs, splash stuck forever.
  Renderer resolution now goes through `app.getAppPath()`, and the check is
  guarded so a diagnostic failure can never abort boot.
- **Splash removed from the launcher** — the window paints in about 1.5 s, and
  a stuck WPF splash was the visible "loading screen". Straight to Electron now.
- **Auto JB instructions dialog fixed** — the editor textarea was pinned to the
  component's 280 px default width and overflowed the 640×480 dialog. It now
  fills an 820×640 dialog, monospace 12/20, no clipping, no scrollbar fight.

## Build

- Free edition: no key, no activation, no usage reset.
- Version line `2027.1.1.6`, separate AppId, installs to `%LOCALAPPDATA%\Programs\jetcode Free`.
- 13,128 signed files, 653 sync-critical, Ed25519 manifest signature rebuilt.
- Auto-update feed: `https://cdn.example.com/free-latest.json`.

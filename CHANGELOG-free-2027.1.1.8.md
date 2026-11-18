# jetcode Free 2027.1.1.8

## Auto JB editor

- Clearing the prompt and hitting Save now persists the empty prompt. Auto JB
  stays enabled and injects no instructions; it no longer silently restores the
  bundled default.
- "Default" and the footer "Delete prompt" now delete the saved override and
  restore the bundled instruction set.
- Switching to Default no longer writes the default text back as a custom
  prompt.
- Saved presets, preset deletion, and the two-step confirms are unchanged.

## Appearance

- Added Background image to Settings → Appearance. Upload a PNG, JPG or WebP
  up to 20 MB; it renders behind the glass when the Clear theme is selected.
  Replace and Remove are available from the same row.

## Branding

- Remaining user-visible "OpenCode" strings removed from the bundled UI:
  desktop menu labels, recovery dialogs, WSL onboarding, terminal errors,
  update toasts, and the theme name.
- Default theme now reports as "jetcode".
- Windows app-menu heading and the free provider row in Settings now read
  "jetcode".

## Startup

- Fixed the local sidecar registration handshake. Local builds write
  `service-local.json`; the desktop now reads that file instead of waiting on
  the old `service.json` until the background-service timeout.

## Linux

- `build-linux-noreset.ps1 -Free` now defaults to the 2027 line instead of
  2099, so a free Linux build cannot accidentally require a key.
- Linux free README no longer claims in-app updates from the licensing Worker.

## Update feed

- Windows free builds keep using the public R2 feed.
- No key, no activation, no heartbeat, no reset UI.

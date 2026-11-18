# jetcode Free 2027.1.1.7

## What's new

- **Auto JB instruction editor, rebuilt.** Pick from the bundled default or any
  preset you have saved, edit inline, save the edit as a named preset, and
  delete presets you no longer use. Deleting the active prompt takes two clicks,
  so a mis-click does not blank your instructions.
- **Revert to default, one click.** The bundled prompt is always available as
  `Default (bundled)`; edit it, save your version as a preset, and the original
  stays intact underneath.
- **Full rebrand.** Every visible "OpenCode" string in the app is now
  "jetcode" — provider names, connect dialogs, usage copy, About, settings,
  pairing text. Code identifiers, config filenames and CLI command names are
  unchanged, so existing setups keep working.

## Fixes

- **Auto JB dialog no longer clips.** The textarea was pinned to the component's
  280 px default width; the dialog now opens at 820×640 and the editor fills it,
  monospace 12/20, no horizontal scroll.
- **Startup stays clean.** No splash window; the Electron window paints in about
  1.5 s on the free edition.

## Build

- Free edition: no key, no activation, no usage reset.
- Version line `2027.1.1.7`, AppId `{B7E4D2A9-3C15-4F8B-8D62-9A1E5C7F2B40}`,
  installs to `%LOCALAPPDATA%\Programs\jetcode Free`.
- Signed file manifest and Ed25519 release signature rebuilt for this version.
- Auto-update feed: `https://cdn.example.com/free-latest.json`.

## Upgrading

Install over the top, or let the updater pull it. No key, no reset, no data
migration. Presets live in the app's local storage and survive the upgrade.

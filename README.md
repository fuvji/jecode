# jetcode â€” Source

A fork of [OpenCode](https://github.com/anomalyco/opencode) (MIT) with a rebranded interface and an Auto JB toggle.

## Included

- `packages/` â€” app, desktop, CLI, core, AI, UI, plugins and the rest of the source tree
- `script/` and `patches/` â€” upstream build tooling
- `installer/jetcode-Setup.iss` â€” the free-edition Inno Setup script
- `shortcuts/jetcode.vbs` â€” the direct launcher
- `CHANGELOG-free-2027.1.1.9.md`

## Not included

Release signing keys, the license Worker, the R2 release feed, private infrastructure, build artifacts, user data, logs and databases. The client references to those services are placeholders; point them at your own deployment.

## Build

`ash
bun install
bun --cwd packages/cli build
bun --cwd packages/desktop build
`

The desktop build produces `packages/desktop/out`. The CLI build produces `packages/cli/dist`. A signed release requires your own Ed25519 key and integrity manifest; a development build does not.

## Free models

The app uses OpenCode's provider. Users can connect their own provider key in Settings. No key is bundled in this repository.

## Auto JB

The toggle is in Settings. The Auto JB prompt is included in `packages/core/src/plugin/abliterated-AGENTS.md`. Edit it in Settings or replace the file.

## License

MIT. Upstream copyright belongs to the OpenCode authors. Fork changes are published under the same license.
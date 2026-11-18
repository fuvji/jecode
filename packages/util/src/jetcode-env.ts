// Imported before the bootstrap in the CLI. Installed builds and service unit
// files written before the rename still export OLLIECODE_* variables; copy any
// that were not explicitly replaced so licences, proxy policy, local endpoints
// and provider keys keep working without asking the user to rewrite them.
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("OLLIECODE_") || value === undefined) continue
  const next = `JETCODE_${key.slice("OLLIECODE_".length)}`
  if (process.env[next] === undefined) process.env[next] = value
}

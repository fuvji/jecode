# jetcode Free 2027.1.1.9

## Images

- Pasted screenshots and attached images now reach the vision-capable fallback
  instead of being replaced with `ERROR: Cannot read ... this model does not
  support image input`. The free catalog reports several models as text-only
  while their endpoint accepts images; the capability preflight no longer
  overrides the provider.
- Image-bearing requests route straight to the vision fallback, so a Snipping
  Tool capture is read as pixels rather than OCR text.
- OCR stays in place for the keyless text-only fallback path.

## Files

- `text/plain` attachments are emitted as message text and read by the model.
- Unknown or binary attachments now include the file path and a `read` hint
  instead of producing no content at all.

## Speed

- After a free-usage `429`, the Retry-After window is remembered and later chat
  steps skip the opencode.ai probe. Replies no longer pay a failed round trip
  on every step.

## Startup

- The desktop chooses a free port when the preferred port is held by another
  process, and reads `service-local.json` for the local channel. This removes
  the `port 3085 already in use` and `Desktop IPC handler failed` boot errors.
- A healthy registered sidecar is reused; a stale local sidecar is terminated
  before the port is reclaimed.

## Tool calls

- A tool call that arrives in the chunk after `finish_reason` is accepted and
  normalized to `tool-calls` instead of ending the turn with text only.

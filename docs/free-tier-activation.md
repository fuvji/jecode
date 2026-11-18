# Free-tier activation

The desktop client now supports a server-issued free key, but the licensing
service is not in this repository. This document defines the endpoint that the
license Worker must provide and the security rules that keep the free tier
legitimate.

## Flow

1. The user enters an email in the activation dialog and selects **Get a free key**.
2. Electron sends `POST /api/free-key` to the configured license origin with the
   normalized email and this machine's HWID.
3. The licensing service validates and rate-limits the request, then issues a
   normal key bound to that email/HWID and the `free` tier.
4. The dialog receives the key, puts it through the regular
   `POST /api/activate` path, verifies the signed token, and stores it locally.
5. The existing license heartbeat, expiry, revocation, and HWID checks continue
   to apply. A free key is not a bypass; it is an entitlement issued by the
   server.

The client never generates a key, never embeds a shared key, and never treats a
local response as proof of entitlement.

## Button

**Get a free key** is always available under the key field. It calls
`/api/free-key` directly; there is no purchase link or website fallback. The
endpoint must be deployed before this build is distributed.

## Endpoint contract

`POST /api/free-key`

Request:

```json
{
  "email": "user@example.com",
  "hwid": "machine-binding-value"
}
```

Success:

```json
{
  "ok": true,
  "key": "ABCDE-FGHIJ-KLMNO-PQRST"
}
```

Failure (HTTP 4xx/5xx):

```json
{
  "ok": false,
  "error": "A human-readable reason"
}
```

The response must not include a signed activation token. The key must still be
redeemed through `/api/activate`, which remains the authority for HWID binding,
tier, expiry, and token signing.

## Server requirements

- Require the same pinned TLS origin used by `/api/activate`.
- Normalize and validate the email. Do not trust the client's claim that the
  user owns the address.
- Rate-limit by IP, email, and HWID. Add a CAPTCHA or equivalent abuse control
  before issuing keys at scale.
- Make issuance idempotent for a given email + HWID, so a retry returns the
  existing active free key instead of creating unlimited keys.
- Limit free keys to the `free` tier. Never let this endpoint mint a paid tier.
- Store key -> email, HWID, tier, issue time, expiry, and revocation state.
- Log issuance without logging full keys; use a short prefix for diagnostics.
- Keep the signing key only on the server. The desktop binary contains only the
  public verification key.
- Return the same generic error for unknown/blocked accounts so the endpoint
  cannot be used to enumerate emails.

## Reference route

The exact database and framework depend on your license Worker. The shape should
be equivalent to:

```ts
app.post("/api/free-key", async (c) => {
  const body = await c.req.json()
  const email = normalizeEmail(body.email)
  const hwid = String(body.hwid ?? "")

  if (!validEmail(email) || !validHwid(hwid)) {
    return c.json({ ok: false, error: "Enter a valid email address." }, 400)
  }
  if (!(await allowFreeKeyRequest(c, email, hwid))) {
    return c.json({ ok: false, error: "Too many requests. Try again later." }, 429)
  }

  // Idempotent: one active free entitlement per email + machine.
  const existing = await db.findFreeKey(email, hwid)
  if (existing && !existing.revoked) {
    return c.json({ ok: true, key: existing.key })
  }

  const key = await db.issueKey({
    email,
    hwid,
    tier: "free",
    expiresAt: freeTierExpiry(),
  })

  return c.json({ ok: true, key })
})
```

Do not replace `db.issueKey` with `crypto.randomUUID()` or a local key generator:
the key must exist in the same store that `/api/activate` validates against.

## Rollout

1. Deploy the Worker route and database migration.
2. Confirm `/api/free-key` is reachable at the same origin as the existing
   `/api/activate`.
3. Set `gateway.json` or `JETCODE_LICENSE_API` to that origin for the build.
4. Test one fresh machine: request a key, activate, restart, and confirm the
   cached license still works.
5. Test duplicate requests, expired/revoked keys, an invalid email, and a
   machine that already has a paid license.
6. Confirm the dialog has no purchase link or website fallback.

## Related client code

- `packages/desktop/src/main/service/licensing-engine.ts` — `requestFreeKey()`
- `packages/desktop/src/main/service/license-gate.ts` — dialog and IPC handler
- `packages/desktop/src/main/service/license-appearance.ts` — dialog styling

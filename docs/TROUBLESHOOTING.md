# Troubleshooting

Failures that cost real time on this project, and what each one actually was.

### Things that cost time, worth knowing

- **ChatGPT caches the tool manifest at registration.** Renaming a tool or editing its
  description will not reach an already-registered connector. Toggling is unreliable; delete and
  re-add. A probe block appears in the server terminal the moment ChatGPT connects, which is the
  quickest way to tell whether it re-fetched.
- **Tool descriptions are routing instructions.** With the official Tableau MCP also registered,
  "show me the dashboard" went to *its* link-returning tool until this tool's description claimed
  the capability that is actually unique - rendering a live interactive viz inline.
- **A disabled Connected App yields Tableau error 10090** at embed time with no other clue.
  `apps/tableau-cloud-provisioner --list` reports enabled state and project scope.
  *Now caught at startup by the preflight, which names it.*
- **`auth-failed` with Tableau error 10085 means regenerate the secret.** *Now caught at startup
  by the preflight.* Seen 2026-08-10, four
  hours after the identical configuration rendered fine. Everything checkable looked correct: app
  `[ENABLED]`, `scope: all projects`, `clientId` matching the JWT `iss`, local clock within a
  second of real time, claims well-formed. A new secret on the existing Connected App fixed it.
  Note this is *not* 10090 - a stale secret and a disabled app present differently, and with a
  stale secret nothing on this side looks wrong. Create the new secret before deleting the old
  one; an app can hold several, so the old one is a free rollback.
- **The tunnel hostname, not the credentials, is what forces a connector re-add.** These are two
  separate problems and `.env` only fixes the first. A quick tunnel's hostname dies with the
  process, and ChatGPT caches the manifest per registration, so a new hostname means deleting and
  re-adding. A stable hostname needs either a domain on Cloudflare (named tunnel) or deploying
  this server somewhere with a fixed address.
- **A demo runs on Tableau Public with no credentials at all.** Clear the five `TABLEAU_*` vars and
  the viz falls back to the published Public dashboard, with the token attribute omitted entirely
  rather than sent empty. Nothing to authenticate means nothing that can 401 mid-recording. The
  tradeoff is that Public captions differ from the Cloud field names (`Sales Region` vs `Region`),
  so a render-then-ask demo will show mismatched labels.
- **Tokens are minted per render**, so enabling the Connected App takes effect on the next embed
  without restarting the server.
- **Check `GET /healthz` before registering anything.** It reports the viz URL actually in use
  plus the preflight verdict, and returns 503 when something is blocking. This catches an
  unsubstituted `TABLEAU_VIZ_URL` - a literal `/views/<workbook>/<view>` signs a perfectly valid
  JWT and registers cleanly, then 404s at embed time and reads like an auth failure.
  *`run.ps1` now does this check for you and refuses to start a tunnel if it fails.*
  `TABLEAU_VIZ_URL` is read once at process start, so changing it needs a restart; the tunnel and
  the ChatGPT registration both survive that restart.
- **Tableau Cloud's address bar gives the wrong URL form.** It shows `/#/site/<site>/views/...`;
  embedding needs `/t/<site>/views/...`.
- **Recovering the tunnel hostname without its terminal:** find the cloudflared metrics port with
  `Get-NetTCPConnection -State Listen -OwningProcess <pid>`, then `curl
  http://127.0.0.1:<port>/quicktunnel`. *`run.ps1` writes it to `outputs\tunnel-url.txt`, so this
  is only needed for a tunnel started by hand.*
- **Auth mode is logged only when a client connects**, inside the capability probe block - not at
  startup. To confirm it without ChatGPT, connect as an MCP client, `resources/read`, and decode
  the JWT embedded in the returned HTML.


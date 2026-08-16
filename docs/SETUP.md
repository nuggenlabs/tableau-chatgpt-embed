# Setup

Everything needed to get the dashboard rendering in ChatGPT, in the order it bites.

## Verify it works

Three independent checks, none of which needs a chat client:

```powershell
npm test   # runs all three

# 1. Does the viz render under the MCP Apps sandbox + CSP?
#    Reproduces the spec's iframe sandbox and CSP locally, drives it headlessly,
#    and reports which of the four layers fails. Writes test/probe-result.png.
node test/feasibility.test.js

# 2. Is the server protocol-correct?
#    Checks tool registration, ui:// linkage, MIME type, and CSP metadata.
node test/server.smoke.js

# 3. Does the preflight classify credential failures correctly?
#    Stubbed fetch - the failures worth covering (stale secret, disabled app,
#    unreachable host) cannot be produced on demand against a working site.
node test/preflight.test.js
```

`feasibility.test.js` exits 0 only if all three hold: the viz reaches `firstinteractive`,
the view satisfies the host sizing contract, and a `ui/update-model-context` push arrives.
It prints the payload the model would receive, which is the only way to see it - the push
is invisible on screen.

One thing it cannot cover: the re-push when a filter actually changes. The filter controls
live inside a cross-origin frame, so no headless driver can click them. The test asserts
the listeners were attached.

**The re-push itself was verified by hand in ChatGPT on 2026-08-10 and passed** - both
`filterchanged` and `parameterchanged` fire, with the filter count moving `0 -> 1`:

```
sent #1 on first render     - 0 filter(s), 3 parameter(s)
sent #2 on filterchanged    - 1 filter(s), 3 parameter(s)
sent #3 on parameterchanged - 1 filter(s), 3 parameter(s)
```

Run that check with `EMBED_DEBUG=1`. The push is invisible on screen, so without the panel
forced on, a broken push and a working one look identical.

**`EMBED_DEBUG` and `EMBED_PROBE_MESSAGES` are separate switches on purpose.** The panel is a
diagnostic *you* read; probe messages are conversation content *the model* reads, delivered as a
user-role message. During a scoping test you want the first and must not have the second - that
extra text competes with the pushed on-screen state, which is what contaminated the 2026-08-10
runs. Failures still report into the chat under either setting.

Two things about how to run it, learned the hard way: the filter has to be changed **by hand**
in the embedded viz - there is no tool for setting a filter, and asking the model to do it will
at best fail and at worst quietly call a *query* tool instead, which looks like success while
exercising none of this code. And nothing visible happens in chat at the moment you click:
`updateModelContext` waits for the user's next message rather than provoking a reply, so silence
there is expected.

## Running it for ChatGPT (the host that works)

ChatGPT connects over HTTP rather than spawning a local process, so the server needs to be
reachable. `run.ps1` starts the server and the tunnel together and prints the URL to paste.

```powershell
cd apps\tableau-mcp-app
cp .env.example .env     # then fill it in - see "Credentials" below
.\run.ps1
```

Anonymous Tableau Public needs no configuration at all; `.env` is only for an authenticated
Cloud embed.

### Credentials: put them in `.env`, once

Credentials used to live only in shell environment variables, so every closed window meant
re-entering five values - and one of the 2026-08-10 failures was a template placeholder pasted
verbatim during exactly that re-entry. `src/env.js` now reads a gitignored `.env` at startup.

**A variable already exported in your shell wins over the file.** That ordering is deliberate:
the file is the convenience, and a value set in the current shell is a deliberate override for
one run - usually a different viz or a freshly regenerated secret. Startup prints which keys
were applied and which were left alone, naming keys only, never values.

`.env.example` is the committed template. `.env` is gitignored and must stay that way - Tableau
Cloud shows a Connected App secret once at creation and it cannot be read back.

It resolves `cloudflared` even though it is not on the default PATH, waits for the server to
come up, runs the preflight below, reads the tunnel hostname out of the tunnel's own log, and
prints the ready-to-paste URL with `/mcp` already appended. Ctrl+C stops both processes; the
URL is also written to `outputs\tunnel-url.txt`.

Register that URL in ChatGPT under Connectors, auth `None`.

| Flag | Effect |
| --- | --- |
| `-EmbedDebug` | `EMBED_DEBUG=1` - forces the on-screen diagnostic panel on |
| `-NoTunnel` | Server only, on `127.0.0.1` |
| `-Port <n>` | Default 8792 |
| `-TunnelName` / `-TunnelHostname` | Named tunnel instead of a quick one - see below |

To run the server by hand instead, `$env:MCP_TRANSPORT = "http"; node src/server.js`, then
`cloudflared tunnel --url http://127.0.0.1:8792` in a second window.

### Preflight: credential problems surface at startup, not inside ChatGPT

Every credential and URL failure on this project has surfaced at *embed* time, as an opaque
`auth-failed` inside ChatGPT - after a tunnel restart and a connector re-registration. The
server now checks what is checkable at boot and names the failing thing. Results print to
stderr and are served on `GET /healthz`, which returns **503** when something is blocking.

It checks: unsubstituted `<...>` placeholders in the viz URL or any credential; the Cloud
address-bar URL form (`/#/site/`) that cannot be embedded; local clock skew against Tableau's
own `Date` header, since JWT `iat`/`exp` are absolute; and - the one that actually exercises
the secret - a REST signin with a token signed by it.

`run.ps1` refuses to start a tunnel when the preflight fails, because correcting it afterwards
costs a delete-and-re-add of the connector.

**The live check is deliberately three-state.** A Connected App may legitimately not be
authorised for REST API access, in which case a perfectly good secret still fails to sign in.
Only a recognised signature or enablement error (10084, 10085, 10090) is reported as `FAIL`;
anything else is `INCONCLUSIVE` and reported verbatim. A false "your secret is bad" would send
you regenerating credentials that were fine, which is worse than not checking.

| Variable | Effect |
| --- | --- |
| `EMBED_DEBUG=1` | On-screen diagnostic panel (a *diagnostic you* read) |
| `EMBED_PROBE_MESSAGES=1` | Probe JSON into the chat on success (*conversation content the model* reads) |
| `TABLEAU_SKIP_PREFLIGHT=1` | Static checks only, no network call |
| `TABLEAU_PREFLIGHT_STRICT=1` | Exit non-zero on a blocking finding instead of warning |
| `TABLEAU_PREFLIGHT_TIMEOUT_MS` | Live check timeout, default 8000 |
| `TABLEAU_REST_API_VERSION` | Default `3.29` (Tableau Cloud 2026.2.5) |

### Named tunnels - and the prerequisite nobody mentions

A quick tunnel's hostname dies with the process, and **every new hostname forces a delete-and-re-add
of the ChatGPT connector**, since the manifest is cached at registration. That happened repeatedly
on 2026-08-10.

A named tunnel fixes it, but only if you own a domain on Cloudflare. This is the part the
docs gloss over: a named tunnel's own `<uuid>.cfargotunnel.com` address is routable *only from
inside Cloudflare Zero Trust*, not from ChatGPT. A stable public hostname requires a DNS record,
which requires a zone, which requires a domain. There is no free stable `trycloudflare.com`
hostname.

One-time setup, once a domain is on Cloudflare:

```powershell
$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
& $cf tunnel login                                    # browser, pick the zone
& $cf tunnel create tableau-mcp
& $cf tunnel route dns tableau-mcp tableau-mcp.example.com
```

Then every run is:

```powershell
.\run.ps1 -TunnelName tableau-mcp -TunnelHostname tableau-mcp.example.com
```

The connector now survives restarts. Until a domain exists, the quick tunnel is the only
option and the re-add is unavoidable.


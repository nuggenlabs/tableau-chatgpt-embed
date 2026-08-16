# Host support

Which AI clients can actually render an embedded Tableau viz, and why one cannot.

## Wiring into Claude Desktop

The config path is **not** the documented `%APPDATA%\Claude\`. Claude Desktop ships as
an MSIX package, which virtualizes that write to:

```
%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

A config written to the documented path is silently ignored. Merge into the existing
file rather than overwriting it — Claude Desktop stores real preferences there.

```json
{
  "mcpServers": {
    "tableau-mcp-app": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\\node-v24.19.0-win-x64\\node.exe",
      "args": ["c:\\Dev\\Tableau-AI-Efficiency-Lab\\apps\\tableau-mcp-app\\src\\server.js"]
    }
  }
}
```

Use the **absolute** Node path. winget installs Node outside the usual location and the
host spawns servers with its own environment, so bare `"node"` fails silently.

Fully quit Claude Desktop from the tray — closing the window leaves it running and it
will not reread the config.


## Known issue: Claude Desktop blocks the nested Tableau iframe

Claude Desktop `1.26832.0.0` on Windows 11 serves the view from a unique subdomain
(`https://<hash>.claudemcpcontent.com`) and enforces a CSP that omits our declared
`frameDomains`. The view reports:

```
! CSP BLOCKED   frame-src -> https://public.tableau.com
```

Everything else in the same host passes: the handshake completes, the widget sizes
correctly, `resourceDomains` loads the Embedding API script, and `connectDomains` allows a
fetch to Tableau returning HTTP 200. Only `frame-src` is withheld. Our declaration uses the
spec field names and appears in both `resources/list` and `resources/read`.

**The host contradicts itself.** On 2026-08-09 the view dumped the host capabilities returned
by `ui/initialize`, and Claude Desktop reports our domains as *approved*:

```json
"sandbox": { "csp": {
  "connectDomains":  ["https://public.tableau.com", "https://*.tableau.com"],
  "resourceDomains": ["https://public.tableau.com", "https://*.tableau.com"],
  "frameDomains":    ["https://public.tableau.com", "https://*.tableau.com"]
}}
```

It then blocks `frame-src` to `https://public.tableau.com` - the exact origin in the list it
just approved. So this is not a host declining a request; it is a host accepting the policy and
enforcing a stricter one. That rules out any remaining possibility of a malformed declaration on
our side, and makes it a Claude Desktop defect rather than a design constraint.

**Retested against Tableau Cloud on 2026-08-09, same result.** Set
`TABLEAU_VIZ_URL=https://<pod>.online.tableau.com/...` and the CSP domains derive to match; the
view reports `CSP BLOCKED: frame-src -> https://<pod>.online.tableau.com`. On that same origin
`script-src` and `connect-src` both succeed. So the block is host-wide rather than specific to
Tableau Public, and no choice of Tableau host avoids it.

Because the Tableau Embedding API renders only into an iframe, this cannot be worked around
server-side. Hosts worth trying instead: VS Code Copilot (stdio, already configured),
MCPJam Inspector (`npx @mcpjam/inspector@latest`), Goose, claude.ai web (needs HTTP
transport).

**Earlier misdiagnosis, recorded so it is not repeated:** this was first attributed to
[ext-apps #671](https://github.com/modelcontextprotocol/ext-apps/issues/671) on 2026-08-07,
when the host painted nothing at all. That symptom had a different cause - the view never
completed the `ui/initialize` handshake, so it never reported a size and the host left the
iframe at zero height. The harness hid this by hard-coding `height: 100%`. Both are fixed;
the `frame-src` block is what remains.


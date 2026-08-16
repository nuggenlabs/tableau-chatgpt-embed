# Tableau MCP App

Render a **live, interactive Tableau dashboard inside ChatGPT**, click a mark, and ask about
what you clicked.

Not a screenshot and not a link out. The real viz, embedded in the conversation, filterable and
hoverable — and when you select something, the selection is pushed to the model so that
*"why is this one so low?"* resolves to the mark under your cursor.

```
You click Fasteners on the dashboard.

  Fasteners selected on "KPI by Sub-Category" - nothing else is filtered.
  Mark: Sub-Category: Fasteners | AGG(KPI Value): 8,532 | AGG(KPI Label): $8.5K
  Parameters: Profit Bin Size = 200 | Top Customers = 5 | p.KPI = Sales

You: "why is this one so low?"

ChatGPT: "Sales: $8,532, lowest of 17 sub-categories. Average line sale: $37.26...
          980 units across 226 orders. Average discount 7.9%, so discounting is
          not the main cause. Profit: $2,429, a healthy 28.5% margin."
```

Those numbers are queried live from the Tableau data source, not invented — verified against the
raw query response, which is a distinction worth insisting on.

## What this actually is

An [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) server. It exposes one tool that
returns a `ui://` resource — an HTML view the host mounts in a sandboxed iframe — which loads the
Tableau Embedding API, renders your viz, and reports the on-screen state back to the model as the
user interacts with it.

It deliberately **returns no data of its own**. The embed supplies the *scope*; a Tableau data
query tool supplies the *numbers*. See [How it works](docs/HOW-IT-WORKS.md) for why that split is
the right one.

## Status, honestly

| | |
| --- | --- |
| **ChatGPT** | Works. Renders, interacts, and pushes state; a selected mark was verified to scope the answer against a live query. You have to name the connector when asking — see [Invoking it](#invoking-it). |
| **Claude Desktop** | Renders nothing. It approves the `frameDomains` CSP declaration and then blocks `frame-src` anyway — a host defect no server-side change can work around. [Details](docs/HOST-SUPPORT.md). |
| **Tableau Public** | Works anonymously, no credentials needed. |
| **Tableau Cloud** | Works, via a Direct Trust Connected App JWT signed server-side. |

This is a working prototype built to answer a question — *can you have a real conversation with a
dashboard you're looking at?* — and the answer turned out to be yes, with caveats worth reading.

## Invoking it

Name the connector:

> *"Use the tableau-embed connector to show me the Superstore Performance dashboard"*

This is the documented invocation, not a workaround for a bug. Asked without naming it,
*"show me the dashboard"* reliably loses to ChatGPT's own chart builder, which will happily
construct a convincing dashboard out of sample data and present it as an answer. Three rewrites of
the tool description failed to change that. Once the dashboard is on screen, ordinary questions
work normally — you only need to name the connector for the initial render.

## Quickstart

Requires Node 18+ and, for the Cloud path, a Tableau Connected App.

```bash
git clone https://github.com/nuggenlabs/tableau-chatgpt-embed.git
cd tableau-chatgpt-embed
npm install
npm test          # proves the viz renders under the real sandbox CSP, headlessly
```

`npm test` is worth running before anything else. It reproduces the MCP Apps iframe sandbox and
its Content Security Policy locally, drives a real Tableau viz through it in headless Chrome, and
tells you which of the four layers fails if one does. It also drives a real mark selection and
asserts the selection reaches the host — so a broken state push fails the build rather than
surfacing as a confused answer three weeks later.

To run it against a dashboard and connect it to ChatGPT:

```bash
cp .env.example .env      # fill in, or delete the four credential lines for Tableau Public
npm start
```

Then expose it over HTTPS and register the `/mcp` URL as a connector. On Windows, `run.ps1` does
the whole sequence — server, tunnel, health check, paste-ready URL:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

Full walkthrough, including the credential traps: **[docs/SETUP.md](docs/SETUP.md)**.

## Documentation

| Document | What's in it |
| --- | --- |
| [Setup](docs/SETUP.md) | Credentials, tunnels, the startup preflight, and getting it into ChatGPT |
| [How it works](docs/HOW-IT-WORKS.md) | Architecture, how on-screen state reaches the model, mark selection |
| [Host support](docs/HOST-SUPPORT.md) | What works where, and the Claude Desktop `frame-src` block in detail |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Failures that cost real time here, and what each one actually was |
| [Scoping test](docs/SCOPING-TEST.md) | A protocol for testing whether the model *uses* on-screen state |

## Two findings worth stealing

**A tool description is a routing instruction — and it can lose.** *"Show me the Superstore
dashboard"* was answered by ChatGPT building a plausible lookalike from a sample dataset — invented
numbers, presented as an answer. Three successive rewrites of the description failed to win the
request back, including one that names the competing behaviour and refuses the substitution
outright. A tool competes with everything the host can do, not just its siblings in the same
server, and against a first-party tool a description may simply not be enough. **Unresolved** —
name the connector, as below.

**Ask the harness, not the model.** A model is not a reliable instrument for measuring its own
context. When on-screen state stopped reaching ChatGPT, four plausible theories each blamed the
wrong layer; what settled it was planting a random token in every push and asking for it back —
thirteen pushes, every call resolved, none delivered. `docs/SCOPING-TEST.md` is the general form of
that lesson.

## Layout

```
src/
  server.js         MCP server: the tool, the ui:// resource, HTTP + stdio transports
  view.html         the embedded view - renders the viz, reads state, pushes it to the model
  build-view.js     inlines the MCP Apps client SDK into the view at build time
  connected-app.js  Direct Trust JWT minting for authenticated Cloud embeds
  preflight.js      startup credential and URL checks, so failures surface here not in ChatGPT
  env.js            dependency-light .env loader; shell variables win over the file
test/
  sandbox-harness.js   reproduces the host: the iframe sandbox, the CSP, the ui/ JSON-RPC contract
  feasibility.test.js  end-to-end - viz renders, host contract satisfied, state reaches the model
  server.smoke.js      MCP protocol correctness
  preflight.test.js    credential-failure classification, stubbed
  env.test.js          .env parsing and precedence
docs/                  see the table above
run.ps1                Windows launcher: server + tunnel + health + paste-ready URL
```

No build step and three runtime dependencies. The Tableau Embedding API is loaded by the view at
runtime from Tableau's own CDN, which the sandbox CSP has to allow — that constraint drives more of
the design than anything else.

## Not yet built

- **Choosing a dashboard by name.** One viz is baked in at startup via `TABLEAU_VIZ_URL`. Switching
  conflicts with the one-embed-per-conversation rule, which exists because a second embed mounts a
  fresh unfiltered viz and silently resets the reported scope.
- **Inbound authentication.** `/mcp` is open to anyone who can reach it, and `resources/read` mints
  an embed token on demand. Fine behind an ephemeral tunnel; **do not put this on a permanent public
  hostname without putting something in front of it.**

## License

MIT — see [LICENSE](LICENSE).

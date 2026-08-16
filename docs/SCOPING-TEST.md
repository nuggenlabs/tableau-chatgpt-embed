# Task 12C - The Scoping Test

> **RUN ON 2026-08-15. First result FAIL, re-run PASS.**
>
> The first run answered about **Central Region** - neither on screen nor typed. The cause was
> ours: the payload said "scope the answer to the selection" and then, two lines later, "questions
> about what is on screen can be answered against the full data source". The model took the
> licence.
>
> With that sentence suppressed whenever a mark is selected, the re-run resolved correctly on the
> first try: *"You selected Fasteners, and the dashboard is currently showing Sales as the KPI.
> Fasteners is at only $8.5K in sales..."* - three facts that exist only in the payload.
>
> ~~**Advisory scoping works. Deterministic scoping is not needed.**~~ **Withdrawn the same
> evening.** Full write-up in the project notes.
>
> **The pushed context is not durable.** Hours after the PASS below, the identical code could name
> neither the selected mark nor the `Profit Bin Size` value it had read back exactly. The payload
> was confirmed correct against the live dashboard by the harness, so this is not comprehension and
> not composition - the state is simply not in front of the model when the question arrives.
>
> **Do not run this test until durability is established**, or you will be measuring whether the
> context happened to survive rather than whether the model scopes to it. Every run recorded as a
> PASS asked its question immediately after a push. The durability check is step 3 of START HERE in
> the project notes: click a mark, then ask "what is selected?" three times a minute apart.
>
> The lesson worth carrying: before concluding a model ignores your instructions, read the whole
> payload for instructions that contradict each other. Two sections written separately can each be
> correct and jointly grant permission to do the wrong thing.

**The one open question:** does the model actually *scope its data query* to what is on screen,
or does it merely receive the state and answer at whatever scope it likes?

Three attempts have failed to settle it. **None failed because the model got it wrong** - each
failed because the run itself was flawed. Read the failure table before running, because the
whole value of this test is in not repeating them.

---

## Why the previous three runs proved nothing

| # | What was done | Why it proved nothing |
|---|---|---|
| 1 | Filtered to Central, asked *"why is Central Region profits down?"* | The question **named Central**. A correct answer is equally explained by the model reading the word. Consistent with scoping; not evidence of it. |
| 2 | Changed filter to East, asked again | The **immediately preceding turn had said "Central" out loud**. The context update was competing with explicit user text one turn earlier - the hardest possible case, and not the one the design targets. |
| 3 | Asked with only this connector enabled | **No query tool was available.** The model said *"I can see your Central filter"* and then that it could not reach the underlying values. Proved the push is read; could not test scoping at all. |

Two failure modes, both avoidable: **the question leaked the answer**, and **the environment was wrong**.

A fourth flaw applies to all three: nobody ever expanded the tool calls, so it was never confirmed
that a Tableau query ran at all rather than the numbers being fabricated from Superstore priors.

---

## Design of the clean test

**The question must not contain the answer, and a wrong scope must produce a visibly different
answer.** Both conditions have to hold, or the run is inconclusive again.

That rules out the obvious subjects. Tables, Bookcases, and Supplies are the famous
negative-profit Superstore sub-categories - the model knows them from priors and will volunteer
them with no data at all. HANDOFF records exactly this failure signature: a hedged answer built
from *"the usual culprits are Tables and Bookcases"*.

**So select something obscure.** `Fasteners` works well - it is small, unremarkable, and no model
prior will offer it unprompted. The headless run selects it naturally:

```
- Sub-Category: Fasteners | AGG(KPI Value): 8,532 | AGG(KPI Label): $8.5K
```

If the model answers about Fasteners, it used the selection. If it answers about Tables or
Bookcases, or hedges across the whole data source, it did not.

---

## Setup

**Both flags matter, and they are now separate switches.** Turn the panel on; leave probe
messages off. Probe JSON arrives as a **user-role message** and is exactly the kind of extra text
that contaminated run #2.

```powershell
cd apps\tableau-mcp-app
# .env holds the credentials; see .env.example
$env:EMBED_DEBUG = "1"            # on-screen panel: confirms each push fired
# do NOT set EMBED_PROBE_MESSAGES - it would inject probe JSON into the transcript
.\run.ps1
```

Then register the printed URL in ChatGPT and check all of the following **before** asking
anything. Every one of these has broken a previous run.

- [ ] `run.ps1` reported `preflight: PASS` (a bad secret otherwise surfaces as `auth-failed` mid-test)
- [ ] The dashboard renders and is interactive
- [ ] **Both** connectors are enabled in this conversation - this app **and** the hosted Tableau MCP
- [ ] The conversation is **brand new**. No earlier turn mentions any region, sub-category, or figure
- [ ] **ChatGPT's cross-conversation memory holds nothing about this project.** A new chat window
      is not a clean context on its own - saved memory carries facts between conversations, and
      several prior sessions discussed Central being the weakest region at length. That is a live
      candidate for where "Central" came from on 2026-08-15, when the model called it *"an
      inference"*. Check saved memories and clear anything Tableau- or Superstore-related, or use a
      Temporary Chat (which neither reads nor writes memory - confirm connectors work there first)
- [ ] **Not inside a Project.** Project-level custom instructions and files are additional context
      the model reads. Projects are the right home for day-to-day use, precisely because they pin
      the connector set - but that same persistence makes them the wrong instrument for a test
- [ ] The diagnostic panel shows `sent #1 on first render`

> **The both-connectors check is the one most often missed.** This app returns no data by design.
> With only it enabled, the model renders, reads the state, and then cannot answer - which reads
> like a bug here but is the connector set being wrong.

> **Temporary Chat did not expose the hosted Tableau MCP** (2026-08-15). Asked what tools it had,
> the model listed only `tableau-embed.embed_interactive_dashboard` and said outright: *"I do not
> currently have a separate Tableau data-query tool exposed in this conversation."* The connector
> was registered at the account level at the time. Cause not pinned down - temp chats may not carry
> hosted connectors at all, or it may need a per-chat toggle that is unavailable there.
>
> **So a Temporary Chat can prove scoping but not the query half.** For the full loop use a normal
> chat with both memory toggles off. Scoping being settled makes memory contamination a much
> smaller concern than it was.
>
> **Ask for the tool list before anything else.** It costs one line and it is reliable - a tool
> manifest is in the model's context, unlike the pushed dashboard state, which it answered about
> incorrectly twice.

---

## The run

1. **Click a single mark** on the dashboard - `Fasteners` in the sub-category view.
2. **Confirm the push landed.** The panel must show a new line:
   `sent #N on markselectionchanged - ... 1 mark(s)`.
   If the mark count is 0, stop: the selection did not reach the view and the rest is noise.
3. **Ask exactly this, and nothing else:**

   > why is this one so low?

   No sub-category name. No region. No figure. The demonstrative is the entire point - if you
   name the thing, you have run attempt #1 again.
4. **Expand the tool calls in the reply.** Not optional: it is the step that was skipped every
   previous time, and without it a fabricated answer is indistinguishable from a queried one.

---

## Reading the result

| Outcome | What it means |
|---|---|
| Answer is about **Fasteners**, and a Tableau query tool ran | **PASS.** Model-as-glue is sufficient. Task 12C closes; VizQL Data Service is code that buys nothing. |
| Answer is about **Tables / Bookcases / Supplies**, or hedges across everything | **FAIL.** The selection was ignored. Scoping must become deterministic - fold VizQL Data Service into this server. |
| Answer names Fasteners but **no query tool ran** | **Inconclusive, and separately alarming.** The model used the pushed context but invented the explanation. Re-run; if it repeats, the numbers cannot be trusted regardless of scoping. |
| The model asks which item you mean | **Soft fail, and useful.** It knew the question was under-specified but did not read the selection as the referent. Try the same question with the mark still selected and the panel confirming a non-zero mark count. |

Record the outcome **including which of these four it was** - the third
row in particular has never been checked and would change what is safe to claim publicly.

---

## Diagnosing a failure: do not ask the model what it received

When a run fails, the obvious next move is to ask the model what it saw. **Don't.** Both attempts
on 2026-08-15 produced answers that were worse than useless:

- *"What is currently selected on the dashboard?"* -> *"The dashboard is currently scoped to the
  Central region"* - contradicting a payload that says "No filter is narrowing it" and names the
  selected mark.
- *"Repeat back, verbatim, the dashboard state block"* -> a refusal to reproduce "hidden/internal
  context blocks", which is a trained behaviour and independent of whether the block exists.

Two instruments that do work:

1. **The harness, for what was sent.** `test/sandbox-harness.js` honours `TABLEAU_VIZ_URL` and the
   Connected App credentials, so `node test/feasibility.test.js` prints the exact payload a live
   Cloud dashboard produces - ground truth, no model in the loop.
2. **A checkable fact, for what arrived.** Ask about something only the payload can answer and no
   prior can supply - e.g. *"What is the Profit Bin Size parameter set to?"* (ground truth: 200).
   A right answer proves delivery; a wrong one proves confabulation; "I don't have access" proves
   non-delivery. If even that is ambiguous, put a random `context-id` in the frontmatter and ask
   for it back - a model cannot guess a nonce.

## What this test does not cover

- **Filters, as opposed to marks.** A click is the stronger signal. If marks pass but you want the
  filter path settled too, repeat with a filter applied and no selection.
- **Whether it holds up over a long conversation.** One clean exchange is the minimum bar, not
  proof of reliability.
- **Claude Desktop.** The dashboard cannot render there at all (`frame-src`), so this test is
  ChatGPT-only until that host is retested.

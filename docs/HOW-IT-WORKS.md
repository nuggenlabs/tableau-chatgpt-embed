# How it works

## How it works

`<tableau-viz>` needs all three CSP domain lists, not just one:

| `_meta.ui.csp` field | CSP directive | What breaks without it |
| --- | --- | --- |
| `resourceDomains` | `script-src`, `style-src`, `img-src`, `font-src` | Embedding API script never loads |
| `frameDomains` | `frame-src` | Element registers but the viz iframe never appears |
| `connectDomains` | `connect-src` | Viz cannot bootstrap after framing |

The middle row is the trap: declare only `resourceDomains` and the custom element
registers successfully, so it looks like it worked until nothing paints.

The CSP is declared on **both** the `resources/list` entry and the `resources/read`
result. The listing value is what hosts review at connection time; the read value is
authoritative. Declaring only one can yield a clean protocol exchange with a silent
no-render.

`src/view.html` is deliberately self-diagnosing. It reports each of the four layers on
screen, so a failure names its own cause instead of showing a blank box.

The server logs the host's negotiated capabilities to stderr on `oninitialized`, which
lands in the host's MCP log. That distinguishes "host doesn't support MCP Apps" from
"host supports it but didn't render" without guessing.


## Relationship to the query half

This project renders a dashboard and reports what it is filtered to. It does not return
data, and adding more rendering will never make it do so. Data questions ("why does this
sub-category have negative profit") are served by Tableau Cloud plus `tableau/tableau-mcp`,
which queries via VizQL Data Service and returns real numbers the model can reason over.
That path has no CSP dependency. See [Host support](HOST-SUPPORT.md).

The two halves meet at the model-context push: this app supplies the *scope* ("Region is
filtered to Central"), the query tool supplies the *numbers*. Without the push, "why is
this down?" gets answered for all regions while the user is staring at one.

**Both connectors have to be enabled in the same ChatGPT conversation.** Deleting and re-adding
this one, or opening a fresh chat, is enough to leave the hosted Tableau MCP switched off - and
the failure is easy to misread as a bug here. The tell is a hedged answer assembled from
Superstore priors ("the usual culprits are Tables and Bookcases") with no real figures, often with
the model saying outright that this connector is not exposing row-level values. It is telling the
truth: this app returns no data. A genuine query answers with states, sub-categories, and discount
rates.


## On-screen state to the model

The model cannot see the viz, so on-screen state has to be sent explicitly. After
`firstinteractive`, and again on every `filterchanged` / `parameterchanged` /
`markselectionchanged`, the view reads the applied filters, parameters, and selected marks
and pushes a Markdown summary over `ui/update-model-context`.

### Selected marks - the "this one" signal

Filters say what the whole view is narrowed to. **A selected mark says which single point the
user is pointing at**, which is what actually happens when someone spots an outlier: they click
it, then ask about it. So marks are rendered *ahead* of the filter prose, and the payload says
plainly that a selection is the most specific statement of what "this" means.

```
selected-marks: 1

THE USER HAS SELECTED 1 MARK(S) ON THE DASHBOARD (on: KPI by Sub-Category). They clicked
these directly, so this is the most specific statement available of what they are asking
about...

Selected marks:
- Sub-Category: Fasteners | AGG(KPI Value): 8,532 | AGG(KPI Label): $8.5K
```

Large selections are capped at 10 marks and say how many were left out - the same lesson as the
truncated filter value lists, since a silently clipped list reads as a complete one.

**Unlike the filter re-push, this one is verified headlessly.** `test/feasibility.test.js`
drives a real selection through `selectMarksByValueAsync` and asserts the marks reach the host.
Two traps cost time and are worth not rediscovering:

- **`SelectionUpdateType.Replace` is `"select-replace"`, not `"replace"`.** `FilterUpdateType`
  and the Extensions API both use the bare `"replace"`, so the obvious guess is rejected with
  `invalid value for enum: SelectionUpdateType`. The value was read out of the embedding bundle.
- **A selection call succeeding is not the same as marks being selected.** Selecting by an
  aggregated measure (`SUM(Sales)`) is accepted and matches nothing. The probe prefers dimension
  columns and confirms with `getSelectedMarksAsync` before reporting success - otherwise it
  reports passing while testing nothing.

**State goes out on both channels, and `sendMessage` is the one that arrives.** The original
choice was `updateModelContext` alone, for good reasons that still read well: context updates
wait for the user's next question instead of provoking a reply, and each replaces the last, so
dragging a slider leaves one accurate statement of on-screen state rather than a running log of
every intermediate position. On 2026-08-15 ChatGPT stopped delivering them - a random per-push
`context-id` came back `not reported` across 13 pushes while every call resolved. The same
payload sent by `sendMessage` arrived intact. Both are sent now (`EMBED_STATE_MESSAGES`, on by
default); restore the preference for `updateModelContext` if it starts delivering again.

**The message copy is rendered compact, and the two copies are not the same text.** A
`sendMessage` payload is not invisible plumbing - it lands in the transcript as user-role text
the audience reads, twice per interaction. So `renderContext(state, id, { compact: true })`
drops the frontmatter, the `captured` timestamp and the single-item list headers, taking the
demo payload from 20 lines to 9. What it does not touch is the two scoping paragraphs: those are
why the model resolves "this one" to the selection, and the one time a sentence near them was
changed the payload started contradicting itself. Shorten around the prose, never through it.
`test/feasibility.test.js` prints both copies with a line and character count, and runs the
contradiction check over both.

**`sendMessage` is a request, not a notification.** It resolves only when the host accepts it,
so a fire-and-forget call reports success whether or not anything was delivered - the same trap
as the mark probe above. The panel row reports from how the promise settles. The harness left
`ui/message` unanswered until 2026-08-16, which meant every headless run was rejecting on
timeout behind a row that said `sent`.

Three things this got wrong at first, all fixed and worth not repeating:

- **`isAllSelected` is not trustworthy.** The WOW dashboard reports `false` for a
  Sub-Category filter that has all 17 values selected. Taken at face value that becomes
  "filtered to these 17" and the model answers a narrowed question about unnarrowed data.
  The check that actually works is comparing `appliedValues.length` against
  `getDomainAsync("relevant")`.
- **A truncated value list must say so.** Long selections are capped, and a quietly clipped
  list reads as the complete selection - so it is rendered as `N of M values, including: …
  (K more not listed here)`.
- **Do not dedupe on the rendered text.** It carries a `captured:` timestamp, so every push
  looks new and the suppression never fires. The comparison is on the state itself.

If the host does not advertise `updateModelContext`, the view logs that and stays quiet
rather than throwing on an unadvertised method.

### Re-rendering silently resets the scope

Found 2026-08-10. Each push replaces the last - that is the point of `updateModelContext` - and a
**second call to the embed tool mounts a fresh, unfiltered viz** whose first-render push says
"nothing is filtered, answer against the full data source." That replaces the state the user
actually has on screen, and the next question gets answered at the wrong scope with no visible
sign anything went wrong.

This is what happened the first time the scoped query was tried: "why are profits down" was enough
display-intent language to make ChatGPT re-embed, and the model then answered with
*"Assuming you mean the sharp drop in April 2026"* - the tell that it had no scope in hand.

The tool description and its return text now both say the tool is called at most once per
conversation, and say why. **Tool descriptions are routing instructions, so the wording is the
mechanism, not documentation** - and ChatGPT caches the manifest at registration, so changing it
requires deleting and re-adding the connector.

The deeper version of this question is Task 12C: whether describing the constraint is enough, or
whether VizQL Data Service belongs inside this server so scoping is deterministic instead of
advisory.


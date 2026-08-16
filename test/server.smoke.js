/**
 * Smoke test: does the MCP server speak the protocol correctly over stdio?
 * Verifies tool registration, ui:// linkage, MIME type, and CSP metadata.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.js"],
});

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? " -> " + detail : ""}`);
  if (!cond) failures++;
};

console.log("=== tools/list ===");
const { tools } = await client.listTools();
const tool = tools.find((t) => t.name === "embed_interactive_dashboard");
check("tool registered", !!tool);
const uiMeta = tool?._meta?.ui;
const legacy = tool?._meta?.["ui/resourceUri"];
check("tool declares _meta.ui.resourceUri", !!uiMeta?.resourceUri, uiMeta?.resourceUri);
check("legacy _meta['ui/resourceUri'] mirrored", !!legacy, legacy);

console.log("=== resources/list ===");
const { resources } = await client.listResources();
check("ui:// resource listed", resources.some((r) => r.uri === uiMeta?.resourceUri));

console.log("=== resources/read ===");
const read = await client.readResource({ uri: uiMeta.resourceUri });
const item = read.contents[0];
check("mimeType is text/html;profile=mcp-app", item.mimeType === "text/html;profile=mcp-app", item.mimeType);
check("html body delivered", (item.text || "").includes("<tableau-viz"), `${(item.text || "").length} bytes`);

const csp = item._meta?.ui?.csp;
check("csp.resourceDomains includes tableau", !!csp?.resourceDomains?.some((d) => d.includes("tableau.com")), JSON.stringify(csp?.resourceDomains));
check("csp.frameDomains includes tableau", !!csp?.frameDomains?.some((d) => d.includes("tableau.com")), JSON.stringify(csp?.frameDomains));
check("csp.connectDomains includes tableau", !!csp?.connectDomains?.some((d) => d.includes("tableau.com")), JSON.stringify(csp?.connectDomains));

console.log("=== tools/call ===");
const result = await client.callTool({ name: "embed_interactive_dashboard", arguments: {} });
check("tool returns content", Array.isArray(result.content) && result.content.length > 0);

// The scoping rule lives here as of 2026-08-16. It used to be appended to every
// state push, but those are visible user-role text and repeating a paragraph of
// instructions on every click reads as machine exhaust on camera. This text is
// in the conversation exactly once, which is the whole reason it can afford to
// be explicit - so it must not be quietly edited away while trimming the return
// text for length. It is the rule that fixed the 2026-08-15 run where a
// selected mark was ignored and the model answered about an invented region.
const returnText = result.content.find((c) => c.type === "text")?.text ?? "";
check(
  "return text resolves the demonstrative to the selection",
  returnText.includes("scope the answer to it"),
);
check(
  "return text refuses to widen on an unfiltered backdrop",
  returnText.includes("Do not widen to the whole data source"),
);
check(
  "return text still forbids a second embed",
  returnText.includes("do not call this tool again"),
);

await client.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);

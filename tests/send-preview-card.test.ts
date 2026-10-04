import assert from "node:assert/strict";
import { sha256Hex } from "../src/mail/draft-verify.ts";
import {
	MCP_APP_MIME_TYPE,
	shortHash,
	SEND_PREVIEW_HTML,
	SEND_PREVIEW_URI,
} from "../src/send-preview-card.ts";

assert.match(SEND_PREVIEW_URI, /^ui:\/\/email\/send-preview-[0-9a-f]{8}\.html$/);
assert.equal(SEND_PREVIEW_URI, `ui://email/send-preview-${shortHash(SEND_PREVIEW_HTML)}.html`);
assert.notEqual(shortHash(SEND_PREVIEW_HTML), shortHash(SEND_PREVIEW_HTML + " "));
assert.equal(shortHash("abc"), shortHash("abc"));
assert.equal(MCP_APP_MIME_TYPE, "text/html;profile=mcp-app");

// The embedded script must at least parse, and must never write message content as HTML.
const script = /<script>([\s\S]*)<\/script>/.exec(SEND_PREVIEW_HTML)?.[1];
assert.ok(script);
new Function(script);
assert.doesNotMatch(script, /innerHTML|outerHTML|document\.write/);
// Sandboxed without scripts; allow-same-origin only lets the card measure the content height.
assert.match(SEND_PREVIEW_HTML, /<iframe[^>]*sandbox="allow-same-origin"/);
assert.doesNotMatch(SEND_PREVIEW_HTML, /allow-scripts|allow-popups|allow-top-navigation/);
assert.match(script, /default-src \\'none\\'/);
assert.match(script, /Math\.min\([^)]*600\)/);
assert.match(script, /host-context-changed/);
assert.match(script, /hostContext/);
assert.match(SEND_PREVIEW_HTML, /prefers-color-scheme: dark/);
assert.match(SEND_PREVIEW_HTML, /<details id="textBox" hidden>/);
assert.match(script, /appInfo/);
assert.doesNotMatch(script, /clientInfo/);
assert.match(script, /ui\/notifications\/size-changed/);
assert.match(script, /ResizeObserver/);
assert.doesNotMatch(SEND_PREVIEW_HTML, /<(script|link)[^>]+(src|href)=/i);
assert.match(script, /email_send_previewed_draft/);
assert.match(script, /email_cancel_previewed_draft/);

assert.equal(
	await sha256Hex("abc"),
	"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
);
assert.notEqual(await sha256Hex(new Uint8Array([1])), await sha256Hex(new Uint8Array([2])));
console.log("ok");

// The URI must come from the one constant everywhere in index.ts (resource and both _meta links).
const { readFileSync } = await import("node:fs");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
assert.doesNotMatch(indexSource, /ui:\/\/email/);
assert.match(indexSource, /resourceUri: SEND_PREVIEW_URI/);
assert.match(indexSource, /"ui\/resourceUri": SEND_PREVIEW_URI/);
assert.match(indexSource, /registerResource\(\s*"email_send_preview_card",\s*SEND_PREVIEW_URI/);

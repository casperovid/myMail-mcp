import assert from "node:assert/strict";
import { sha256Hex } from "../src/mail/draft-verify.ts";
import {
	MCP_APP_MIME_TYPE,
	SEND_PREVIEW_HTML,
	SEND_PREVIEW_URI,
} from "../src/send-preview-card.ts";

assert.equal(SEND_PREVIEW_URI, "ui://email/send-preview.html");
assert.equal(MCP_APP_MIME_TYPE, "text/html;profile=mcp-app");

// The embedded script must at least parse, and must never write message content as HTML.
const script = /<script>([\s\S]*)<\/script>/.exec(SEND_PREVIEW_HTML)?.[1];
assert.ok(script);
new Function(script);
assert.doesNotMatch(script, /innerHTML|outerHTML|document\.write/);
assert.match(SEND_PREVIEW_HTML, /<iframe[^>]*sandbox=""/);
assert.match(script, /email_send_previewed_draft/);
assert.match(script, /email_cancel_previewed_draft/);

assert.equal(
	await sha256Hex("abc"),
	"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
);
assert.notEqual(await sha256Hex(new Uint8Array([1])), await sha256Hex(new Uint8Array([2])));
console.log("ok");

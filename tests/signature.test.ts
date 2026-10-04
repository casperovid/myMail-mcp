import assert from "node:assert/strict";
import { findDraftMismatches } from "../src/mail/draft-verify.ts";
import { buildDraftMessage } from "../src/mail/mime.ts";
import {
	SIGNATURE_HTML,
	SIGNATURE_TEXT,
	appendHtmlSignature,
	appendTextSignature,
	htmlToText,
	signedBody,
	stripSignature,
	wrapHtmlBody,
	textToHtml,
} from "../src/mail/signature.ts";

assert.equal(SIGNATURE_TEXT, "- - -\n\nCasper Ovid\ncasperovid.no — 93409091");

// Exactly one blank line above the dashes, with or without trailing line breaks.
assert.equal(appendTextSignature("Hei"), `Hei\n\n${SIGNATURE_TEXT}`);
assert.equal(appendTextSignature("Hei\n"), `Hei\n\n${SIGNATURE_TEXT}`);
assert.equal(appendTextSignature("Hei\n\n\n"), `Hei\n\n${SIGNATURE_TEXT}`);
assert.equal(appendHtmlSignature("Hei"), `Hei<br>${SIGNATURE_HTML}`);
assert.equal(appendHtmlSignature("Hei<br><br>"), `Hei<br>${SIGNATURE_HTML}`);
assert.match(`Hei<br>${SIGNATURE_HTML}`, /Hei<br><br>- - -<br><br><b>Casper Ovid<\/b>/);

// Never twice.
assert.equal(appendTextSignature(appendTextSignature("Hei")), `Hei\n\n${SIGNATURE_TEXT}`);
assert.equal(appendHtmlSignature(appendHtmlSignature("Hei")), `Hei<br>${SIGNATURE_HTML}`);
const once = signedBody("Hei", undefined);
assert.deepEqual(signedBody(once.text, once.html), once);
assert.equal(signedBody(once.text, undefined).text, once.text);
assert.equal(signedBody(once.text, undefined).html, once.html);
assert.equal(signedBody(undefined, once.html).text, once.text);

// Text is escaped, line breaks become <br>; only-html input derives the plain text.
assert.equal(textToHtml('a < b & "c"\nd'), "a &lt; b &amp; &quot;c&quot;<br>d");
assert.equal(htmlToText("Hei<br>du &amp; jeg<p>x</p>"), "Hei\ndu & jeg\n\nx");
assert.equal(signedBody(undefined, "<p>Hei</p>").text, `Hei\n\n${SIGNATURE_TEXT}`);
assert.equal(signedBody("Hi\nthere", undefined).html, `Hi<br>there<br>${SIGNATURE_HTML}`);

// Empty body: only the signature.
assert.equal(signedBody("", undefined).text, SIGNATURE_TEXT);

assert.equal(stripSignature(`Hei\n\n${SIGNATURE_TEXT}\n`), "Hei");
assert.equal(stripSignature("Hei"), "Hei");

// Verification ignores the signature on either side but still catches real differences.
const draft = { to: ["a@example.com"], cc: [], subject: "S", text: once.text };
assert.deepEqual(
	findDraftMismatches({ to: "a@example.com", subject: "S", text: "Hei" }, draft),
	[],
);
assert.deepEqual(
	findDraftMismatches({ to: "a@example.com", subject: "S", text: once.text }, draft),
	[],
);
assert.equal(
	findDraftMismatches({ to: "a@example.com", subject: "S", text: "Noe annet" }, draft).length,
	1,
);

// MIME: both versions end up as multipart/alternative, plain first.
const source = new TextDecoder().decode(
	buildDraftMessage("s@example.com", { to: "r@example.com", subject: "S", ...once }).source,
);
assert.match(source, /Content-Type: multipart\/alternative/);
assert.ok(source.indexOf("text/plain") < source.indexOf("text/html"));

// Composed HTML is wrapped once in the font div; the signature is unchanged and still detected.
const wrapped = wrapHtmlBody(once.html);
assert.ok(wrapped.startsWith('<div style="font-family: Helvetica, Arial, sans-serif;">'));
assert.ok(wrapped.endsWith("</div>"));
assert.ok(wrapped.includes(SIGNATURE_HTML));
assert.doesNotMatch(wrapped, /color/i);
assert.equal(wrapHtmlBody(wrapped), wrapped);
assert.equal(appendHtmlSignature(wrapped), wrapped);
assert.equal(signedBody(undefined, wrapped).html, once.html);
const unsignedWrapped = wrapHtmlBody("Hei");
assert.equal(wrapHtmlBody(appendHtmlSignature(unsignedWrapped)), wrapped);

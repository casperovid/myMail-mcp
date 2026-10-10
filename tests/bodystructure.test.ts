import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import { parseBodyStructure, parseSexp } from "../src/mail/bodystructure.ts";
import {
	assemblePartMessage,
	assembleTextMessage,
	stripContentHeaders,
} from "../src/mail/partial-message.ts";

const enc = new TextEncoder();

const MIXED =
	'* 3 FETCH (UID 247 BODYSTRUCTURE (("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 120 4 NIL NIL NIL)' +
	'("text" "html" ("charset" "iso-8859-1") NIL NIL "7bit" 300 9 NIL NIL NIL)' +
	'("image" "png" ("name" "image (8).png") "<cid1>" NIL "base64" 8000000 NIL ("attachment" ("filename" "image (8).png")) NIL NIL)' +
	'("application" "pdf" ("name" "a.pdf") NIL NIL "base64" 400 NIL ("inline" ("filename" "a.pdf")) NIL NIL)' +
	'"mixed" ("boundary" "xx") NIL NIL NIL))';

test("parseSexp handles nesting, NIL, numbers and escaped quotes", () => {
	assert.deepEqual(parseSexp('("a" NIL 12 ("b\\"c" x))'), ["a", null, 12, ['b"c', "x"]]);
	assert.throws(() => parseSexp("(a {5}"), /Literal/);
	assert.throws(() => parseSexp('("a'), /Unterminated/);
});

test("BODYSTRUCTURE lists text parts and numbered attachments", () => {
	const { textParts, attachments } = parseBodyStructure(MIXED);
	assert.deepEqual(
		textParts.map((part) => part.part),
		["1", "2"],
	);
	assert.deepEqual(
		attachments.map((item) => [item.attachmentIndex, item.part, item.filename]),
		[
			[0, "3", "image (8).png"],
			[1, "4", "a.pdf"],
		],
	);
	assert.equal(attachments[0].decodedSize, 6_000_000);
});

test("nested multipart gets dotted part numbers; single part is part 1", () => {
	const nested = parseBodyStructure(
		'* 1 FETCH (BODYSTRUCTURE (("text" "plain" NIL NIL NIL "7bit" 1 1 NIL NIL NIL) (("text" "html" NIL NIL NIL "7bit" 2 1 NIL NIL NIL)("image" "gif" NIL NIL NIL "base64" 4 NIL NIL NIL NIL) "related") "alternative"))',
	);
	assert.deepEqual(
		nested.textParts.map((part) => part.part),
		["1", "2.1"],
	);
	assert.equal(nested.attachments[0].part, "2.2");
	const single = parseBodyStructure(
		'* 1 FETCH (BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 5 1 NIL NIL NIL))',
	);
	assert.equal(single.textParts[0].part, "1");
	assert.equal(single.attachments.length, 0);
});

test("text part with attachment disposition is an attachment; message/rfc822 is a leaf", () => {
	const result = parseBodyStructure(
		'* 1 FETCH (BODYSTRUCTURE (("text" "plain" NIL NIL NIL "7bit" 1 1 NIL ("attachment" ("filename" "n.txt")) NIL NIL)("message" "rfc822" NIL NIL NIL "7bit" 99 (NIL) (("text" "plain" NIL NIL NIL "7bit" 1 1 NIL NIL NIL) "mixed") 5 NIL NIL NIL NIL) "mixed"))',
	);
	assert.equal(result.textParts.length, 0);
	assert.deepEqual(
		result.attachments.map((item) => `${item.part}:${item.type}/${item.subtype}`),
		["1:text/plain", "2:message/rfc822"],
	);
});

test("attachmentIndex agrees with mailparser's attachment order", async () => {
	const raw = [
		"From: a@example.com",
		"Subject: t",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="B"',
		"",
		"--B",
		"Content-Type: text/plain",
		"",
		"hello",
		"--B",
		"Content-Type: image/png; name=one.png",
		"Content-Transfer-Encoding: base64",
		"Content-Disposition: attachment; filename=one.png",
		"",
		"AAAA",
		"--B",
		"Content-Type: application/pdf; name=two.pdf",
		"Content-Transfer-Encoding: base64",
		"",
		"BBBB",
		"--B--",
		"",
	].join("\r\n");
	const parsed = await simpleParser(Buffer.from(raw));
	const structure = parseBodyStructure(
		'* 1 FETCH (BODYSTRUCTURE (("text" "plain" NIL NIL NIL "7bit" 5 1 NIL NIL NIL)("image" "png" ("name" "one.png") NIL NIL "base64" 4 NIL ("attachment" ("filename" "one.png")) NIL)("application" "pdf" ("name" "two.pdf") NIL NIL "base64" 4 NIL NIL NIL) "mixed"))',
	);
	assert.deepEqual(
		structure.attachments.map((item) => item.filename),
		parsed.attachments.map((item) => item.filename),
	);
});

test("stripContentHeaders drops Content-* and folded continuations", () => {
	const out = stripContentHeaders(
		'Subject: x\r\nContent-Type: multipart/mixed;\r\n boundary="b"\r\nTo: a@b\r\n continued\r\nMIME-Version: 1.0\r\n\r\n',
	);
	assert.equal(out, "Subject: x\r\nTo: a@b\r\n continued");
});

test("assembled text message decodes charset and encoding, without attachments", async () => {
	const header = enc.encode(
		'From: a@example.com\r\nSubject: =?utf-8?Q?Hei?=\r\nContent-Type: multipart/mixed; boundary="zz"\r\n\r\n',
	);
	const parts = [
		{
			mime: enc.encode(
				"Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n",
			),
			body: enc.encode("Hei p=C3=A5 deg"),
		},
		{
			mime: enc.encode("Content-Type: text/html; charset=iso-8859-1\r\n\r\n"),
			body: new Uint8Array([60, 112, 62, 0xe6, 60, 47, 112, 62]),
		},
	];
	const parsed = await simpleParser(Buffer.from(assembleTextMessage(header, parts, "BND")));
	assert.equal(parsed.subject, "Hei");
	assert.equal(parsed.text?.trim(), "Hei på deg");
	assert.match(String(parsed.html), /<p>æ<\/p>/);
	assert.equal(parsed.attachments.length, 0);
});

test("assemblePartMessage decodes one base64 attachment", async () => {
	const mime = enc.encode(
		'Content-Type: image/png; name="a.png"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="a.png"\r\n\r\n',
	);
	const parsed = await simpleParser(
		Buffer.from(assemblePartMessage(mime, enc.encode("aGVsbG8=\r\n"))),
	);
	assert.equal(parsed.attachments.length, 1);
	assert.equal(parsed.attachments[0].filename, "a.png");
	assert.equal(parsed.attachments[0].content.toString(), "hello");
});

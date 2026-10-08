import assert from "node:assert/strict";
import { buildDraftMessage, decodeHeaderWords, type DraftInput } from "../src/mail/mime.ts";

function draftSource(input: DraftInput): string {
	return new TextDecoder().decode(
		buildDraftMessage("sender@example.com", {
			to: "recipient@example.com",
			subject: "Draft test",
			...input,
		}).source,
	);
}

const plain = draftSource({ text: "Plain draft body" });
assert.match(
	plain,
	/Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPlain draft body/,
);
assert.doesNotMatch(plain, /Content-Transfer-Encoding: base64/);

const titled = draftSource({ subject: "Café update - résumé", text: "Body" });
const subject = titled.match(/^Subject: (.+)$/m)?.[1];
assert.ok(subject);
assert.doesNotMatch(subject, /^=\?UTF-8\?B\?/i);
assert.equal(decodeHeaderWords(subject), "Café update - résumé");

assert.equal(decodeHeaderWords("=?UTF-8?B?Q2Fmw6kgVXBkYXRl?="), "Café Update");
assert.equal(decodeHeaderWords("=?UTF-8?Q?Caf=C3=A9_Update?="), "Café Update");
assert.equal(decodeHeaderWords("=?UTF-8?B?Q2Fmw6k=?= =?UTF-8?B?IFVwZGF0ZQ==?="), "Café Update");

const unicode = draftSource({ text: "cafe = café\ntrailing space \n" });
assert.match(unicode, /cafe =3D caf=C3=A9\r\ntrailing space=20\r\n/);

const alternative = draftSource({
	text: "Plain version",
	html: "<p>HTML = café</p>",
});
// The header is folded after the ";" (RFC 5322 78-character lines), so unfold before matching.
assert.match(
	alternative.replace(/\r\n[ \t]/g, " "),
	/Content-Type: multipart\/alternative; boundary="[^"]+"/,
);
assert.match(
	alternative,
	/Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPlain version/,
);
assert.match(
	alternative,
	/Content-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>HTML =3D caf=C3=A9<\/p>/,
);
assert.doesNotMatch(alternative, /Content-Transfer-Encoding: base64/);

const withAttachment = draftSource({
	text: "See attached",
	attachments: [
		{
			filename: "hello.txt",
			contentType: "text/plain",
			contentBase64: "SGVsbG8=",
		},
	],
});
assert.match(
	withAttachment,
	/Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSee attached/,
);
assert.match(
	withAttachment,
	/Content-Type: text\/plain\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="hello\.txt"/,
);

const replyTo = draftSource({
	text: "Reply here",
	replyTo: "Jörg, Support <reply@example.com>",
});
assert.match(replyTo, /^Reply-To: =\?UTF-8\?Q\?J=C3=B6rg,_Support\?= <reply@example\.com>$/m);

// --- Header folding, References trimming and line lengths ---
{
	const { simpleParser } = await import("mailparser");
	const { foldHeader, trimReferences, HEADER_LINE_LIMIT, MAX_REFERENCES } =
		await import("../src/mail/mime.ts");
	const unfold = (value: string) => value.replace(/\r\n[ \t]/g, " ");
	const ids = Array.from(
		{ length: 60 },
		(_, index) => `<${crypto.randomUUID()}-${index}@mail.example.test>`,
	);

	// References: first id + the latest ones, folded, and still a valid thread when parsed.
	const trimmed = trimReferences(ids);
	assert.equal(trimmed.length, MAX_REFERENCES);
	assert.equal(trimmed[0], ids[0]);
	assert.deepEqual(trimmed.slice(1), ids.slice(-(MAX_REFERENCES - 1)));
	assert.deepEqual(trimReferences(ids.slice(0, 5)), ids.slice(0, 5));
	assert.deepEqual(trimReferences([ids[0], ids[0], ids[1]]), [ids[0], ids[1]]);

	const reply = draftSource({
		text: "Hei",
		references: ids,
		inReplyTo: ids[59],
		to: Array.from(
			{ length: 30 },
			(_, index) => `Mottaker Nummer ${index} <person${index}@example.test>`,
		),
		subject: "Et svært langt emne med æøå ".repeat(8),
	});
	const headerBlock = reply.slice(0, reply.indexOf("\r\n\r\n"));
	for (const line of headerBlock.split("\r\n"))
		assert.ok(
			line.length <= HEADER_LINE_LIMIT,
			`header line too long (${line.length}): ${line}`,
		);
	const parsed = await simpleParser(Buffer.from(reply));
	assert.deepEqual(parsed.references, trimmed);
	assert.equal(parsed.inReplyTo, ids[59]);
	assert.equal(parsed.subject?.trim(), "Et svært langt emne med æøå ".repeat(8).trim());
	assert.equal((parsed.to as any).value.length, 30);
	assert.match(
		unfold(headerBlock),
		new RegExp(`References: ${ids[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `),
	);

	// foldHeader: folds at spaces, keeps content, leaves unbreakable tokens, never folds short lines.
	const folded = foldHeader(`X-Test: ${"word ".repeat(40).trim()}`);
	assert.ok(folded.split("\r\n").every((line) => line.length <= HEADER_LINE_LIMIT));
	assert.equal(unfold(folded), `X-Test: ${"word ".repeat(40).trim()}`);
	assert.equal(foldHeader("Subject: short"), "Subject: short");
	const unbreakable = `X-Id: <${"a".repeat(200)}@x>`;
	// A token that cannot be broken moves to its own continuation line and is otherwise untouched.
	assert.equal(foldHeader(unbreakable), `X-Id:\r\n <${"a".repeat(200)}@x>`);
	assert.equal(unfold(foldHeader(unbreakable)), unbreakable.replace("X-Id: ", "X-Id: "));
	assert.ok(foldHeader(`X: ${"a".repeat(100)} ${"b".repeat(10)}`).includes("\r\n "));

	// Body: no line longer than 998 characters (quoted-printable keeps them at 76), for text,
	// html, non-ASCII text and attachments.
	const longText = `${"abc ".repeat(2000)}\n${"é".repeat(3000)}`;
	const longHtml = `<p>${"<b>x</b>".repeat(3000)}</p>`;
	const withAttachment = draftSource({
		text: longText,
		html: longHtml,
		attachments: [
			{
				filename: `${"lang ".repeat(40)}å.pdf`,
				contentType: "application/pdf",
				contentBase64: Buffer.from("x".repeat(100_000)).toString("base64"),
			},
		],
	});
	for (const source of [
		draftSource({ text: longText }),
		draftSource({ html: longHtml }),
		withAttachment,
	])
		for (const line of source.split("\r\n"))
			assert.ok(line.length <= 998, `line too long (${line.length})`);
	for (const line of withAttachment.split("\r\n"))
		assert.ok(line.length <= 78 || !/^[A-Z][\w-]*: /.test(line), line);
	const roundTrip = await simpleParser(Buffer.from(withAttachment));
	assert.equal(roundTrip.text?.replace(/\s+/g, " ").startsWith("abc abc"), true);
	assert.equal(roundTrip.attachments[0].content.length, 100_000);
}

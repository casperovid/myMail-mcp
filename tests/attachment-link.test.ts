import assert from "node:assert/strict";
import {
	DOWNLOAD_PREFIX,
	attachmentDisposition,
	createAttachmentLink,
	createAttachmentToken,
	openAttachmentLink,
} from "../src/attachment-link.ts";
import { takeBytes } from "../src/mail/byte-reader.ts";
import { sealJson } from "../src/crypto.ts";

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const env = { CREDENTIAL_ENCRYPTION_KEY: key, PUBLIC_BASE_URL: "https://mcp.example.test/" };
const ref = { accountId: "acc", folder: "INBOX", uid: 239, attachmentIndex: 0 };
const tokenOf = (url: string) => url.slice(url.indexOf(DOWNLOAD_PREFIX) + DOWNLOAD_PREFIX.length);

// Link: right base URL and path, 15 minute expiry, and the token opens to the same reference.
const before = Date.now();
const { downloadUrl, expiresAt } = await createAttachmentLink(env, ref);
assert.ok(downloadUrl.startsWith(`https://mcp.example.test${DOWNLOAD_PREFIX}`));
const ttl = Date.parse(expiresAt) - before;
assert.ok(ttl > 14.9 * 60_000 && ttl < 15.1 * 60_000);
assert.deepEqual(await openAttachmentLink(env, tokenOf(downloadUrl)), ref);

// Edited, foreign-key, wrong-type, and expired tokens are all rejected.
const token = tokenOf(downloadUrl);
const edited = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
assert.equal(await openAttachmentLink(env, edited), undefined);
assert.equal(await openAttachmentLink(env, "not-a-token"), undefined);
const otherKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
assert.equal(await openAttachmentLink({ CREDENTIAL_ENCRYPTION_KEY: otherKey }, token), undefined);
const claims = { ...ref, typ: "dl", exp: Math.floor(Date.now() / 1000) + 60 };
assert.deepEqual((await openAttachmentLink(env, await sealJson(claims, key)))?.uid, 239);
assert.equal(
	await openAttachmentLink(env, await sealJson({ ...claims, typ: "at" }, key)),
	undefined,
);
assert.equal(
	await openAttachmentLink(
		env,
		await sealJson({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }, key),
	),
	undefined,
);

// The card token is the same sealed token, so the app-only tool and the link accept it alike.
const cardToken = await createAttachmentToken(env, ref);
assert.deepEqual(await openAttachmentLink(env, cardToken.token), ref);
assert.ok(cardToken.token.length >= 20);

// Default base URL when the variable is missing.
assert.match(
	(await createAttachmentLink({ CREDENTIAL_ENCRYPTION_KEY: key }, ref)).downloadUrl,
	/^https:\/\/mcp\.casperovid\.no\/myMail\/download\//,
);

// Filenames cannot break out of the header; non-ASCII is carried in filename*.
assert.equal(
	attachmentDisposition("image (8).png"),
	`attachment; filename="image (8).png"; filename*=UTF-8''image%20(8).png`,
);
assert.doesNotMatch(attachmentDisposition('a"\r\nX: y.png'), /[\r\n]/);
assert.match(
	attachmentDisposition("blåbær.pdf"),
	/filename="bl_b_r\.pdf"; filename\*=UTF-8''bl%C3%A5b%C3%A6r\.pdf/,
);

// takeBytes: a literal split over many chunks comes out intact, with the remainder kept.
const data = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251);
const chunks = [];
for (let offset = 0; offset < data.length; offset += 777)
	chunks.push(data.slice(offset, offset + 777));
let next = 0;
const read = async () => {
	if (next >= chunks.length) throw new Error("closed");
	return chunks[next++] as Uint8Array;
};
const prefix = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
const first = await takeBytes(prefix, 60_000, read);
assert.deepEqual(first.value, data.slice(0, 60_000));
const second = await takeBytes(first.rest, 40_000, read);
assert.deepEqual(second.value, data.slice(60_000));
assert.equal(second.rest.length, 0);
// Exactly one buffered piece, and a prefix larger than the request.
const small = await takeBytes(new Uint8Array([1, 2, 3, 4, 5]), 2, read);
assert.deepEqual([...small.value], [1, 2]);
assert.deepEqual([...small.rest], [3, 4, 5]);
console.log("ok");

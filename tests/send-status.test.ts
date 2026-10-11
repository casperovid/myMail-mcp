import assert from "node:assert/strict";
import { sealJson } from "../src/crypto.ts";
import {
	approvalState,
	cancelApproval,
	consumeApproval,
	putApproval,
} from "../src/send-approval.ts";
import { nextVersion, recordReplacement, walkChain } from "../src/draft-chain.ts";
import { createStatusToken, decideSendState, openStatusToken } from "../src/send-status.ts";

function fakeKv() {
	const data = new Map<string, string>();
	return {
		data,
		async get(key: string) {
			return data.get(key) ?? null;
		},
		async put(key: string, value: string) {
			data.set(key, value);
		},
		async delete(key: string) {
			data.delete(key);
		},
	} as any;
}
const record = { accountId: "acc", folder: "INBOX.Drafts", uid: 409, contentHash: "h" };
const token = "t".repeat(43);

// Approval states: active -> sent (marker) / cancelled (marker) / expired.
let kv = fakeKv();
assert.equal(await approvalState(kv, token, 1_000), "expired"); // unknown token
await putApproval(kv, token, record);
assert.equal(await approvalState(kv, token), "active");
assert.equal(await approvalState(kv, token), "active"); // no time expiry
await consumeApproval(kv, token);
assert.equal(await approvalState(kv, token), "sent");
await cancelApproval(kv, token); // must not overwrite "sent"
assert.equal(await approvalState(kv, token), "sent");

kv = fakeKv();
await putApproval(kv, token, record);
await cancelApproval(kv, token);
assert.equal(await approvalState(kv, token), "cancelled");
await assert.rejects(consumeApproval(kv, token), /invalid/);
assert.equal(await approvalState(kv, token), "cancelled"); // a failed use leaves the marker

kv = fakeKv();
await cancelApproval(kv, "u".repeat(43)); // cancelling an unknown token marks nothing
assert.equal(await approvalState(kv, "u".repeat(43)), "expired");

// Decision: a Sent copy always wins; otherwise the marker decides.
assert.equal(decideSendState("active", true), "sent");
assert.equal(decideSendState("expired", true), "sent");
assert.equal(decideSendState("sent", true), "sent");
assert.equal(decideSendState("sent", false), "sending_started");
assert.equal(decideSendState("active", false), "active");
assert.equal(decideSendState("cancelled", false), "cancelled");
assert.equal(decideSendState("expired", false), "expired");

// Replaced / deleted drafts never show as active.
assert.equal(decideSendState("active", false, { replaced: true }), "replaced");
assert.equal(decideSendState("expired", false, { replaced: true }), "replaced");
assert.equal(decideSendState("active", false, { draftExists: false }), "deleted");
assert.equal(decideSendState("expired", false, { draftExists: false }), "deleted");
assert.equal(decideSendState("active", false, { draftExists: true }), "active");
assert.equal(decideSendState("active", true, { replaced: true, draftExists: false }), "sent");
assert.equal(decideSendState("cancelled", false, { replaced: true }), "cancelled");

// Replacement chain: A -> B -> C. Sent copy of the latest wins; otherwise "replaced".
{
	const links = new Map<string, string>();
	const chainKv = {
		get: async (k: string) => links.get(k) ?? null,
		put: async (k: string, v: string) => void links.set(k, v),
	} as any;
	await recordReplacement(chainKv, "acc", "<a>", "<b>");
	await recordReplacement(chainKv, "acc", "<b>", "<c>");
	await recordReplacement(chainKv, "acc", "<c>", "<c>"); // no self link
	assert.equal(await nextVersion(chainKv, "acc", "<a>"), "<b>");
	assert.equal(await nextVersion(chainKv, "other", "<a>"), undefined);
	const next = (id: string) => nextVersion(chainKv, "acc", id);
	const sentIds = new Set<string>();
	const sentCopy = async (id: string) => (sentIds.has(id) ? { date: "d" } : undefined);
	let result = await walkChain("<a>", { next, sentCopy });
	assert.deepEqual(result, { last: "<c>", replaced: true });
	sentIds.add("<c>");
	result = await walkChain("<a>", { next, sentCopy });
	assert.deepEqual(result, { last: "<c>", replaced: true, sent: { date: "d" } });
	assert.deepEqual(await walkChain("<c>", { next, sentCopy }), {
		last: "<c>",
		replaced: false,
		sent: { date: "d" },
	});
	await recordReplacement(chainKv, "acc", "<c>", "<a>"); // a loop must end
	sentIds.clear();
	assert.equal((await walkChain("<a>", { next, sentCopy })).replaced, true);
}

// Status token: round trip, tampering, wrong type, expiry, wrong key.
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const ref = { accountId: "acc", messageId: "<d6c4ab64@email-mcp-worker>" };
const statusToken = await createStatusToken(key, ref);
assert.deepEqual(await openStatusToken(key, statusToken), ref);
assert.equal(await openStatusToken(other, statusToken), undefined);
assert.equal(await openStatusToken(key, statusToken.slice(0, -2) + "AA"), undefined);
assert.equal(await openStatusToken(key, "garbage"), undefined);
const exp = Math.floor(Date.now() / 1000);
assert.equal(
	await openStatusToken(key, await sealJson({ ...ref, typ: "dl", exp: exp + 60 }, key)),
	undefined,
);
assert.equal(
	await openStatusToken(key, await sealJson({ ...ref, typ: "ss", exp: exp - 1 }, key)),
	undefined,
);
console.log("ok");

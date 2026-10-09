import assert from "node:assert/strict";
import { sealJson } from "../src/crypto.ts";
import {
	approvalState,
	cancelApproval,
	consumeApproval,
	putApproval,
} from "../src/send-approval.ts";
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
await putApproval(kv, token, record, 1_000);
assert.equal(await approvalState(kv, token, 2_000), "active");
assert.equal(await approvalState(kv, token, 1_000 + 15 * 60 * 1000 + 1), "expired");
await consumeApproval(kv, token, 2_000);
assert.equal(await approvalState(kv, token, 3_000), "sent");
await cancelApproval(kv, token); // must not overwrite "sent"
assert.equal(await approvalState(kv, token, 3_000), "sent");

kv = fakeKv();
await putApproval(kv, token, record, 1_000);
await cancelApproval(kv, token);
assert.equal(await approvalState(kv, token, 2_000), "cancelled");
await assert.rejects(consumeApproval(kv, token, 2_000), /invalid/);
assert.equal(await approvalState(kv, token, 2_000), "cancelled"); // a failed use leaves the marker

kv = fakeKv();
await cancelApproval(kv, "u".repeat(43)); // cancelling an unknown token marks nothing
assert.equal(await approvalState(kv, "u".repeat(43), 1), "expired");

// An expired record that is used is refused and gets no "sent" marker.
kv = fakeKv();
await putApproval(kv, token, record, 1_000);
await assert.rejects(consumeApproval(kv, token, 1_000 + 15 * 60 * 1000 + 1), /expired/);
assert.equal(await approvalState(kv, token, 1_000 + 15 * 60 * 1000 + 1), "expired");

// Decision: a Sent copy always wins; otherwise the marker decides.
assert.equal(decideSendState("active", true), "sent");
assert.equal(decideSendState("expired", true), "sent");
assert.equal(decideSendState("sent", true), "sent");
assert.equal(decideSendState("sent", false), "sending_started");
assert.equal(decideSendState("active", false), "active");
assert.equal(decideSendState("cancelled", false), "cancelled");
assert.equal(decideSendState("expired", false), "expired");

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

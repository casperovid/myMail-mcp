import assert from "node:assert/strict";
import { cancelApproval, consumeApproval, putApproval } from "../src/send-approval.ts";

function fakeKv() {
	const data = new Map<string, { value: string; options?: any }>();
	return {
		data,
		async get(key: string) {
			return data.get(key)?.value ?? null;
		},
		async put(key: string, value: string, options?: any) {
			data.set(key, { value, options });
		},
		async delete(key: string) {
			data.delete(key);
		},
	} as any;
}

const record = { accountId: "acc", folder: "INBOX.Drafts", uid: 409, contentHash: "abc123" };
const token = "t".repeat(43);

// The approval is visible through the shared store, whichever MCP session reads it.
const kv = fakeKv();
await putApproval(kv, token, record);
// No time-based expiry: the stored value has no TTL and is accepted however late it is used.
assert.equal(kv.data.get(`send-preview:${token}`).options, undefined);
assert.deepEqual(await consumeApproval(kv, token), record);

// One-time: a second use fails, as does an unknown token.
await assert.rejects(consumeApproval(kv, token), /invalid, already used, or cancelled/);
await assert.rejects(consumeApproval(kv, "x".repeat(43)), /invalid/);

// Cancel removes it; a corrupt value is refused.
await putApproval(kv, token, record);
await cancelApproval(kv, token);
await assert.rejects(consumeApproval(kv, token), /invalid/);
await kv.put(`send-preview:${token}`, "not json");
await assert.rejects(consumeApproval(kv, token), /invalid/);
console.log("ok");

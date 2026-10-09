import assert from "node:assert/strict";
import {
	APPROVAL_TTL_MS,
	cancelApproval,
	consumeApproval,
	putApproval,
} from "../src/send-approval.ts";

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
const stored = await putApproval(kv, token, record, 1_000);
assert.equal(stored.expiresAt, 1_000 + APPROVAL_TTL_MS);
assert.equal(kv.data.get(`send-preview:${token}`).options.expirationTtl, 900);
assert.deepEqual(await consumeApproval(kv, token, 2_000), stored);

// One-time: a second use fails, as does an unknown token.
await assert.rejects(
	consumeApproval(kv, token, 2_000),
	/invalid, already used, cancelled, or expired/,
);
await assert.rejects(consumeApproval(kv, "x".repeat(43), 2_000), /invalid/);

// Expired approvals are refused (and removed).
await putApproval(kv, token, record, 1_000);
await assert.rejects(consumeApproval(kv, token, 1_000 + APPROVAL_TTL_MS + 1), /expired/);
assert.equal(
	[...kv.data.keys()].filter((key: string) => key.startsWith("send-preview:")).length,
	0,
);

// Cancel removes it; a corrupt value is refused.
await putApproval(kv, token, record, 1_000);
await cancelApproval(kv, token);
await assert.rejects(consumeApproval(kv, token, 2_000), /invalid/);
await kv.put(`send-preview:${token}`, "not json");
await assert.rejects(consumeApproval(kv, token, 2_000), /invalid/);
console.log("ok");

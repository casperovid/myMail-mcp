/**
 * One-time send approvals for the email_preview_send card, stored in KV.
 *
 * They used to live in the MCP session's Durable Object storage, which is private to one
 * session. The card's Send call can arrive on a different MCP session than the model's preview
 * call, and then the token was not found. KV is shared by all sessions.
 */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;
const PREFIX = "send-preview:";

export interface ApprovalRecord {
	accountId: string;
	folder: string;
	uid: number;
	contentHash: string;
	expiresAt: number;
}

type ApprovalStore = Pick<KVNamespace, "get" | "put" | "delete">;

export async function putApproval(
	kv: ApprovalStore,
	token: string,
	record: Omit<ApprovalRecord, "expiresAt">,
	now = Date.now(),
): Promise<ApprovalRecord> {
	const stored: ApprovalRecord = { ...record, expiresAt: now + APPROVAL_TTL_MS };
	// KV's minimum TTL is 60 seconds; expiresAt is still checked on use.
	await kv.put(PREFIX + token, JSON.stringify(stored), {
		expirationTtl: Math.ceil(APPROVAL_TTL_MS / 1000),
	});
	return stored;
}

/** Returns the record and removes it first, so a token can never be replayed, even if sending fails. */
export async function consumeApproval(
	kv: ApprovalStore,
	token: string,
	now = Date.now(),
): Promise<ApprovalRecord> {
	const raw = await kv.get(PREFIX + token);
	await kv.delete(PREFIX + token);
	let record: ApprovalRecord | undefined;
	try {
		record = raw ? (JSON.parse(raw) as ApprovalRecord) : undefined;
	} catch {
		record = undefined;
	}
	if (!record || typeof record.expiresAt !== "number" || record.expiresAt < now)
		throw new Error(
			"The send approval token is invalid, already used, cancelled, or expired. Create a new preview with email_preview_send.",
		);
	return record;
}

export async function cancelApproval(kv: ApprovalStore, token: string): Promise<void> {
	await kv.delete(PREFIX + token);
}

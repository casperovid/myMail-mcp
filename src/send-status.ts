import { openJson, sealJson } from "./crypto.ts";
import type { ApprovalState } from "./send-approval.ts";

/** What the send card shows. */
export type SendState = "sent" | "sending_started" | "active" | "cancelled" | "expired";

const STATUS_TTL_SECONDS = 90 * 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

export interface StatusRef {
	accountId: string;
	messageId: string;
}

/**
 * Sealed (AES-GCM) reference to a previewed draft: the account and the Message-ID to look for in
 * the Sent folder. Long-lived because a card can be opened again long after it was created.
 */
export async function createStatusToken(key: string, ref: StatusRef): Promise<string> {
	return sealJson({ ...ref, typ: "ss", exp: now() + STATUS_TTL_SECONDS }, key);
}

export async function openStatusToken(key: string, token: string): Promise<StatusRef | undefined> {
	try {
		const claims = await openJson<Partial<StatusRef> & { typ?: string; exp?: number }>(
			token,
			key,
		);
		if (
			claims?.typ !== "ss" ||
			typeof claims.exp !== "number" ||
			claims.exp < now() ||
			typeof claims.accountId !== "string" ||
			typeof claims.messageId !== "string"
		)
			return undefined;
		return { accountId: claims.accountId, messageId: claims.messageId };
	} catch {
		return undefined;
	}
}

/**
 * A copy in the Sent folder always means sent. Without one, the approval marker decides:
 * "sent" in the marker but no copy means sending started but the copy was not found.
 */
export function decideSendState(approval: ApprovalState, sentCopyFound: boolean): SendState {
	if (sentCopyFound) return "sent";
	if (approval === "sent") return "sending_started";
	return approval;
}

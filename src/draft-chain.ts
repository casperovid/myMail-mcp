/**
 * Which draft replaced which. email_update_message_draft saves a new draft (new UID and
 * Message-ID) and deletes the old one, so a send card that points at the old draft would find
 * nothing. The edit leaves a link old Message-ID -> new Message-ID in KV, and the card's status
 * check follows these links to the latest version.
 */
const PREFIX = "draft-next:";
/** As long as the card's status reference (90 days). */
const LINK_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_HOPS = 20;

type LinkStore = Pick<KVNamespace, "get" | "put">;

export async function recordReplacement(
	kv: LinkStore,
	accountId: string,
	oldMessageId: string,
	newMessageId: string,
): Promise<void> {
	if (oldMessageId === newMessageId) return;
	await kv.put(`${PREFIX}${accountId}:${oldMessageId}`, newMessageId, {
		expirationTtl: LINK_TTL_SECONDS,
	});
}

export async function nextVersion(
	kv: LinkStore,
	accountId: string,
	messageId: string,
): Promise<string | undefined> {
	return (await kv.get(`${PREFIX}${accountId}:${messageId}`)) ?? undefined;
}

export interface ChainResult<Copy> {
	/** The latest version found in the chain. */
	last: string;
	/** True when a newer version than `start` exists. */
	replaced: boolean;
	/** A Sent copy of any version in the chain, which settles the question. */
	sent?: Copy;
}

/** Follows replacement links from `start`, stopping at the first version that was sent. */
export async function walkChain<Copy>(
	start: string,
	deps: {
		next: (messageId: string) => Promise<string | undefined>;
		sentCopy: (messageId: string) => Promise<Copy | undefined>;
	},
): Promise<ChainResult<Copy>> {
	const seen = new Set<string>();
	let current = start;
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		seen.add(current);
		const sent = await deps.sentCopy(current);
		if (sent) return { last: current, replaced: current !== start, sent };
		const next = await deps.next(current);
		if (!next || seen.has(next)) return { last: current, replaced: current !== start };
		current = next;
	}
	return { last: current, replaced: current !== start };
}

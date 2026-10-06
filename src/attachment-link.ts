import { openJson, sealJson } from "./crypto.ts";

/** Signed, expiring download links for message attachments. */
export const DOWNLOAD_PREFIX = "/myMail/download/";
export const DOWNLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_BASE_URL = "https://mcp.casperovid.no";

export interface AttachmentRef {
	accountId?: string;
	folder: string;
	uid: number;
	attachmentIndex: number;
}

export interface LinkEnv {
	CREDENTIAL_ENCRYPTION_KEY: string;
	PUBLIC_BASE_URL?: string;
}

type Claims = AttachmentRef & { typ: "dl"; exp: number };

const now = () => Math.floor(Date.now() / 1000);

/** The token is AES-GCM sealed with CREDENTIAL_ENCRYPTION_KEY, so it cannot be forged or edited. */
export async function createAttachmentLink(
	env: LinkEnv,
	ref: AttachmentRef,
): Promise<{ downloadUrl: string; expiresAt: string }> {
	const exp = now() + DOWNLOAD_TTL_SECONDS;
	const claims: Claims = {
		typ: "dl",
		exp,
		accountId: ref.accountId,
		folder: ref.folder,
		uid: ref.uid,
		attachmentIndex: ref.attachmentIndex,
	};
	const token = await sealJson(claims, env.CREDENTIAL_ENCRYPTION_KEY);
	const base = (env.PUBLIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
	return {
		downloadUrl: `${base}${DOWNLOAD_PREFIX}${token}`,
		expiresAt: new Date(exp * 1000).toISOString(),
	};
}

/** Returns the attachment reference, or undefined for a bad, edited, wrong-type, or expired token. */
export async function openAttachmentLink(
	env: LinkEnv,
	token: string,
): Promise<AttachmentRef | undefined> {
	try {
		const claims = await openJson<Partial<Claims>>(token, env.CREDENTIAL_ENCRYPTION_KEY);
		if (
			claims?.typ !== "dl" ||
			typeof claims.exp !== "number" ||
			claims.exp < now() ||
			typeof claims.folder !== "string" ||
			!Number.isInteger(claims.uid) ||
			!Number.isInteger(claims.attachmentIndex)
		)
			return undefined;
		return {
			accountId: claims.accountId,
			folder: claims.folder,
			uid: claims.uid as number,
			attachmentIndex: claims.attachmentIndex as number,
		};
	} catch {
		return undefined;
	}
}

/** Content-Disposition that always downloads and carries a safe filename (ASCII fallback + UTF-8). */
export function attachmentDisposition(filename: string | undefined): string {
	const name = (filename || "attachment").replace(/[\r\n\\/"]/g, "_").slice(0, 200);
	const ascii = name.replace(/[^\x20-\x7e]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

import { openJson } from "./crypto.ts";

export type BearerProblem =
	| "no_token"
	| "invalid_token"
	| "wrong_token_type"
	| "expired"
	| "wrong_audience"
	| "not_allowed";

/**
 * Says why a bearer token would be rejected, for logging only. It returns a category and never
 * the token or any of its contents. `undefined` means the token is acceptable.
 */
export async function diagnoseBearer(
	authorization: string | null,
	key: string,
	expectedAudience: string,
	isAllowed: (login: unknown) => boolean,
	now = Math.floor(Date.now() / 1000),
): Promise<BearerProblem | undefined> {
	const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
	if (!match) return "no_token";
	let claims: Record<string, unknown>;
	try {
		claims = await openJson<Record<string, unknown>>(match[1], key);
	} catch {
		return "invalid_token";
	}
	if (!claims || claims.typ !== "at") return "wrong_token_type";
	if (typeof claims.exp !== "number" || claims.exp < now) return "expired";
	if (!isAllowed(claims.sub)) return "not_allowed";
	if (claims.aud !== expectedAudience) return "wrong_audience";
	return undefined;
}

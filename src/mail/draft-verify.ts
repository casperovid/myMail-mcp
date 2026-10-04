import { stripSignature } from "./signature.ts";

export interface DraftExpectation {
	to: string | string[];
	cc?: string | string[];
	subject: string;
	text: string;
}

export interface DraftActual {
	to: string[];
	cc: string[];
	subject: string;
	text: string;
}

export function normalizeText(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeAddresses(value: string | string[] | undefined): string[] {
	const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
	return [...new Set(list.map((address) => address.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Returns one human-readable line per field that differs between the provided and stored draft. */
export function findDraftMismatches(provided: DraftExpectation, draft: DraftActual): string[] {
	const mismatches: string[] = [];
	const checkAddresses = (field: "to" | "cc") => {
		const want = normalizeAddresses(provided[field]);
		const have = normalizeAddresses(draft[field]);
		if (want.join(",") !== have.join(","))
			mismatches.push(
				`${field}: provided [${want.join(", ")}] but draft has [${have.join(", ")}]`,
			);
	};
	checkAddresses("to");
	checkAddresses("cc");
	for (const field of ["subject", "text"] as const) {
		// The server appends its signature to the stored text; the caller need not repeat it.
		const clean = (value: string) =>
			normalizeText(field === "text" ? stripSignature(value) : value);
		const want = clean(provided[field]);
		const have = clean(draft[field]);
		if (want !== have)
			mismatches.push(
				`${field}: provided ${JSON.stringify(want)} but draft has ${JSON.stringify(have)}`,
			);
	}
	return mismatches;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

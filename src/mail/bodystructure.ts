/**
 * Parser for the IMAP BODYSTRUCTURE response. Used to list attachments and to fetch only the
 * text/HTML parts of a message instead of the whole source.
 *
 * Attachment classification follows mailparser (which decides what `simpleParser` lists as
 * `attachments`): a leaf part is body text when its type is text/plain, text/html or
 * message/delivery-status and its disposition is not "attachment"; every other leaf is an
 * attachment. `attachmentIndex` is the order of attachment leaves in the structure.
 */

export type Sexp = string | null | number | Sexp[];

export interface BodyLeaf {
	/** IMAP section number, e.g. "1", "2.1". */
	part: string;
	type: string;
	subtype: string;
	params: Record<string, string>;
	encoding: string;
	/** Size of the encoded part as reported by the server. */
	size: number;
	disposition?: string;
	filename?: string;
}

export interface AttachmentLeaf extends BodyLeaf {
	attachmentIndex: number;
	/** Decoded size, estimated from the encoded size. */
	decodedSize: number;
}

export interface BodyStructure {
	textParts: BodyLeaf[];
	attachments: AttachmentLeaf[];
}

/** Parses the first parenthesized list or atom in `input`; throws on literals or bad syntax. */
export function parseSexp(input: string): Sexp {
	let pos = 0;
	const skipSpace = () => {
		while (input[pos] === " ") pos++;
	};
	const value = (): Sexp => {
		skipSpace();
		const char = input[pos];
		if (char === "(") {
			pos++;
			const list: Sexp[] = [];
			while (true) {
				skipSpace();
				if (pos >= input.length) throw new Error("Unterminated list in BODYSTRUCTURE");
				if (input[pos] === ")") {
					pos++;
					return list;
				}
				list.push(value());
			}
		}
		if (char === '"') {
			pos++;
			let out = "";
			while (pos < input.length && input[pos] !== '"') {
				if (input[pos] === "\\") pos++;
				out += input[pos++];
			}
			if (pos >= input.length) throw new Error("Unterminated string in BODYSTRUCTURE");
			pos++;
			return out;
		}
		if (char === "{") throw new Error("Literal in BODYSTRUCTURE");
		const start = pos;
		while (pos < input.length && !" ()".includes(input[pos])) pos++;
		if (pos === start) throw new Error("Unexpected token in BODYSTRUCTURE");
		const atom = input.slice(start, pos);
		if (atom.toUpperCase() === "NIL") return null;
		return /^\d+$/.test(atom) ? Number(atom) : atom;
	};
	return value();
}

/** Extracts and parses the BODYSTRUCTURE list from an untagged FETCH response line. */
export function parseBodyStructure(fetchLine: string): BodyStructure {
	const match = /BODYSTRUCTURE\s+/i.exec(fetchLine);
	if (!match) throw new Error("No BODYSTRUCTURE in response");
	const root = parseSexp(fetchLine.slice(match.index + match[0].length));
	if (!Array.isArray(root)) throw new Error("Malformed BODYSTRUCTURE");
	const leaves: BodyLeaf[] = [];
	walk(root, "", leaves, true);
	const textParts: BodyLeaf[] = [];
	const attachments: AttachmentLeaf[] = [];
	for (const leaf of leaves) {
		if (isBodyText(leaf)) textParts.push(leaf);
		else
			attachments.push({
				...leaf,
				attachmentIndex: attachments.length,
				decodedSize: decodedSize(leaf.size, leaf.encoding),
			});
	}
	return { textParts, attachments };
}

function walk(node: Sexp[], prefix: string, out: BodyLeaf[], top: boolean): void {
	if (Array.isArray(node[0])) {
		let number = 0;
		for (const child of node) {
			if (!Array.isArray(child)) break;
			number++;
			walk(child, prefix ? `${prefix}.${number}` : String(number), out, false);
		}
		return;
	}
	const type = String(node[0] ?? "").toLowerCase();
	const subtype = String(node[1] ?? "").toLowerCase();
	const params = toParams(node[2]);
	// Field positions after the size depend on the type (RFC 3501 7.4.2).
	let dispositionAt = 8;
	if (type === "text") dispositionAt = 9;
	else if (type === "message" && subtype === "rfc822") dispositionAt = 11;
	const disposition = node[dispositionAt];
	let dispositionName: string | undefined;
	let dispositionParams: Record<string, string> = {};
	if (Array.isArray(disposition)) {
		dispositionName = String(disposition[0] ?? "").toLowerCase() || undefined;
		dispositionParams = toParams(disposition[1]);
	}
	out.push({
		part: prefix || (top ? "1" : ""),
		type,
		subtype,
		params,
		encoding: String(node[5] ?? "7bit").toLowerCase(),
		size: typeof node[6] === "number" ? node[6] : 0,
		disposition: dispositionName,
		filename: dispositionParams.filename ?? params.name,
	});
}

function toParams(value: Sexp | undefined): Record<string, string> {
	const params: Record<string, string> = {};
	if (!Array.isArray(value)) return params;
	for (let index = 0; index + 1 < value.length; index += 2)
		params[String(value[index]).toLowerCase()] = String(value[index + 1] ?? "");
	return params;
}

function isBodyText(leaf: BodyLeaf): boolean {
	const type = `${leaf.type}/${leaf.subtype}`;
	const textType = ["text/plain", "text/html", "message/delivery-status"].includes(type);
	// mailparser: unknown dispositions count as attachment, only "inline" or none is body text.
	return textType && (leaf.disposition === undefined || leaf.disposition === "inline");
}

function decodedSize(size: number, encoding: string): number {
	return encoding === "base64" ? Math.floor((size * 3) / 4) : size;
}

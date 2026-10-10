/**
 * Builds small RFC 822 messages from the pieces fetched by section, so mailparser can decode
 * charsets and transfer encodings without the attachments being downloaded.
 */

const CONTENT_HEADER = /^(content-|mime-version)/i;
const decoder = new TextDecoder("latin1");
const encoder = new TextEncoder();

/** Removes Content-* and MIME-Version headers (including folded continuation lines). */
export function stripContentHeaders(header: string): string {
	const kept: string[] = [];
	let skipping = false;
	for (const line of header.split(/\r?\n/)) {
		if (/^[ \t]/.test(line)) {
			if (!skipping) kept.push(line);
			continue;
		}
		skipping = CONTENT_HEADER.test(line);
		if (!skipping && line !== "") kept.push(line);
	}
	return kept.join("\r\n");
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/** The part's own header block, ending in an empty line; a default when the server sent none. */
function partHeader(mime: Uint8Array): Uint8Array {
	if (mime.length === 0) return encoder.encode("Content-Type: text/plain\r\n\r\n");
	const text = decoder.decode(mime);
	return /\r?\n\r?\n$/.test(text) ? mime : concat([mime, encoder.encode("\r\n\r\n")]);
}

/**
 * A message with the original headers and only the given text parts. A plain text part with
 * an HTML part is the usual "alternative" pair; mailparser would otherwise append the HTML
 * to the text, so that case is built as multipart/alternative.
 */
export function assembleTextMessage(
	header: Uint8Array,
	parts: { mime: Uint8Array; body: Uint8Array }[],
	boundary = `=_mcp_${crypto.randomUUID()}`,
): Uint8Array {
	const types = parts.map(
		({ mime }) => /content-type:\s*text\/(plain|html)/i.exec(decoder.decode(mime))?.[1],
	);
	const subtype =
		types.length === 2 && types.includes("plain") && types.includes("html")
			? "alternative"
			: "mixed";
	const chunks: Uint8Array[] = [
		encoder.encode(
			`${stripContentHeaders(decoder.decode(header))}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/${subtype}; boundary="${boundary}"\r\n\r\n`,
		),
	];
	for (const part of parts) {
		chunks.push(encoder.encode(`--${boundary}\r\n`), partHeader(part.mime), part.body);
		chunks.push(encoder.encode("\r\n"));
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`));
	return concat(chunks);
}

/** A standalone message made of one part, so mailparser decodes it as a single attachment. */
export function assemblePartMessage(mime: Uint8Array, body: Uint8Array): Uint8Array {
	return concat([encoder.encode("MIME-Version: 1.0\r\n"), partHeader(mime), body]);
}

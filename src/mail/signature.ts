/**
 * The signature added to every draft this server composes (single place to change it).
 * The plain and HTML versions must say the same thing; both are added exactly once.
 */
export const SIGNATURE_TEXT = "- - -\n\nCasper Ovid\ncasperovid.no — 93409091";
export const SIGNATURE_HTML =
	'<br>- - -<br><br><b>Casper Ovid</b><br><a href="https://www.casperovid.no">casperovid.no</a>&nbsp;—&nbsp;<a href="tel:+4793409091">93409091</a>';

const signatureTail = new RegExp(
	`\\s*${SIGNATURE_TEXT.split(/\s+/)
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s+")}\\s*$`,
);

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

export function hasTextSignature(text: string): boolean {
	return normalize(text).includes(normalize(SIGNATURE_TEXT));
}

export function hasHtmlSignature(html: string): boolean {
	return html.includes(SIGNATURE_HTML);
}

/** Removes the plain signature from the end of a text, if present. */
export function stripSignature(text: string): string {
	return text.replace(signatureTail, "");
}

/** Appends the plain signature after exactly one blank line, unless the text already has it. */
export function appendTextSignature(text: string): string {
	if (hasTextSignature(text)) return text;
	const body = text.trimEnd();
	return body ? `${body}\n\n${SIGNATURE_TEXT}` : SIGNATURE_TEXT;
}

/** Appends the HTML signature after exactly one blank line, unless the HTML already has it. */
export function appendHtmlSignature(html: string): string {
	if (hasHtmlSignature(html)) return html;
	// SIGNATURE_HTML starts with its own <br>, so one more <br> makes the blank line.
	return `${html.replace(/(?:<br\s*\/?>|\s)+$/i, "")}<br>${SIGNATURE_HTML}`;
}

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
	);
}

export function textToHtml(text: string): string {
	return escapeHtml(text.replace(/\r\n?/g, "\n")).replace(/\n/g, "<br>");
}

/** Minimal HTML to plain text: <br> and block ends become line breaks, tags are dropped. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<p(\s[^>]*)?>/gi, "\n\n")
		.replace(/<\/p\s*>/gi, "\n\n")
		.replace(/<\/(div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/gi, "&")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Builds the text and HTML versions of a draft's own message (the part before any quoted
 * or forwarded original) and adds the signature to each, once. If only one version is
 * given, the other is derived from it.
 */
export function signedBody(
	text: string | undefined,
	html: string | undefined,
): { text: string; html: string } {
	const plain = text ?? (html !== undefined ? htmlToText(html) : "");
	const markup = html ?? textToHtml(stripSignature(text ?? ""));
	return { text: appendTextSignature(plain), html: appendHtmlSignature(markup) };
}

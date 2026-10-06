/**
 * Reads exactly `length` bytes from an already-buffered prefix plus further chunks.
 * Pieces are collected and joined once; joining after every chunk copies the buffer
 * quadratically, which made large IMAP literals (attachments) very slow.
 * Returns the bytes and whatever was read beyond them.
 */
export async function takeBytes(
	buffered: Uint8Array<ArrayBuffer>,
	length: number,
	read: () => Promise<Uint8Array>,
): Promise<{ value: Uint8Array; rest: Uint8Array<ArrayBuffer> }> {
	const parts: Uint8Array[] = [];
	let have = 0;
	let rest = buffered;
	while (have < length) {
		if (rest.length === 0) rest = (await read()) as Uint8Array<ArrayBuffer>;
		const take = Math.min(length - have, rest.length);
		parts.push(rest.subarray(0, take));
		rest = rest.subarray(take) as Uint8Array<ArrayBuffer>;
		have += take;
	}
	if (parts.length === 1) return { value: parts[0].slice(), rest };
	const value = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		value.set(part, offset);
		offset += part.length;
	}
	return { value, rest };
}

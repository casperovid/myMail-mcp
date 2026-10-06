import { Buffer } from "node:buffer";

/** Image types the attachment card can show. SVG is deliberately not included. */
export const PREVIEW_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_INPUT_BYTES = 20 * 1024 * 1024; // Images binding input limit
export const MAX_SIDE = 1568;
export const PASS_THROUGH_BYTES = 1_000_000;
export const MAX_PREVIEW_BYTES = 2_000_000;
export const JPEG_QUALITY = 80;

export interface PreviewImage {
	mimeType: string;
	base64: string;
	width?: number;
	height?: number;
	resized: boolean;
}

const stream = (bytes: Uint8Array) => new Blob([bytes as unknown as ArrayBuffer]).stream();

export function isPreviewImageType(contentType: string | undefined): boolean {
	return PREVIEW_IMAGE_TYPES.includes(normalizeType(contentType));
}

function normalizeType(contentType: string | undefined): string {
	const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
	return type === "image/jpg" ? "image/jpeg" : type;
}

/**
 * Returns the image to show on the card, or undefined when there is nothing to show (not a
 * supported image, too large for the binding, binding missing or failing, result too large).
 * Images within MAX_SIDE and PASS_THROUGH_BYTES are shown as they are; others are scaled down
 * to at most MAX_SIDE px as JPEG on a white background.
 */
export async function previewImage(
	images: ImagesBinding | undefined,
	contentType: string | undefined,
	bytes: Uint8Array,
): Promise<PreviewImage | undefined> {
	const type = normalizeType(contentType);
	if (!isPreviewImageType(type) || bytes.byteLength > MAX_INPUT_BYTES) return undefined;
	try {
		let width: number | undefined;
		let height: number | undefined;
		if (images) {
			const info = await images.info(stream(bytes));
			if ("width" in info) ({ width, height } = info);
		}
		const fits =
			width !== undefined &&
			height !== undefined &&
			Math.max(width, height) <= MAX_SIDE &&
			bytes.byteLength <= PASS_THROUGH_BYTES;
		if (fits || !images) {
			// Without the binding only small files can be shown unchanged.
			if (bytes.byteLength > PASS_THROUGH_BYTES) return undefined;
			return {
				mimeType: type,
				base64: Buffer.from(bytes).toString("base64"),
				width,
				height,
				resized: false,
			};
		}
		const result = await images
			.input(stream(bytes))
			.transform({
				width: MAX_SIDE,
				height: MAX_SIDE,
				fit: "scale-down",
				background: "#ffffff",
			})
			.output({ format: "image/jpeg", quality: JPEG_QUALITY, background: "#ffffff" });
		const output = new Uint8Array(await new Response(result.image()).arrayBuffer());
		if (output.byteLength > MAX_PREVIEW_BYTES) return undefined;
		return {
			mimeType: "image/jpeg",
			base64: Buffer.from(output).toString("base64"),
			resized: true,
		};
	} catch {
		return undefined;
	}
}

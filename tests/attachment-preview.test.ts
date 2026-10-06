import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ATTACHMENT_PREVIEW_HTML, ATTACHMENT_PREVIEW_URI } from "../src/attachment-card.ts";
import {
	MAX_PREVIEW_BYTES,
	MAX_SIDE,
	PASS_THROUGH_BYTES,
	isPreviewImageType,
	previewImage,
} from "../src/attachment-image.ts";
import { shortHash } from "../src/send-preview-card.ts";

// --- card ---
assert.match(ATTACHMENT_PREVIEW_URI, /^ui:\/\/email\/attachment-preview-[0-9a-f]{8}\.html$/);
assert.equal(
	ATTACHMENT_PREVIEW_URI,
	`ui://email/attachment-preview-${shortHash(ATTACHMENT_PREVIEW_HTML)}.html`,
);
const script = /<script>([\s\S]*)<\/script>/.exec(ATTACHMENT_PREVIEW_HTML)?.[1];
assert.ok(script);
new Function(script);
assert.doesNotMatch(script, /innerHTML|outerHTML|document\.write|eval\(/);
assert.match(script, /appInfo/);
assert.match(script, /ui\/notifications\/size-changed/);
assert.match(script, /ui\/open-link/);
// The card fetches the attachment itself with the app-only tool; link and image never come from _meta.
assert.match(script, /email_get_attachment_preview/);
assert.match(script, /cardToken/);
assert.doesNotMatch(script, /meta\.(image|downloadUrl)|result\._meta\.(image|downloadUrl)/);
assert.doesNotMatch(ATTACHMENT_PREVIEW_HTML, /diag/i);
assert.match(script, /host-context-changed/);
assert.match(script, /\^image\\\/\(png\|jpeg\|gif\|webp\)\$/); // image mime allowlist, no svg
assert.doesNotMatch(ATTACHMENT_PREVIEW_HTML, /<(script|link)[^>]+(src|href)=/i);
assert.doesNotMatch(ATTACHMENT_PREVIEW_HTML, /<iframe/i);

// The URI comes from the constant, and the tool is registered with it.
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
assert.match(indexSource, /resourceUri: ATTACHMENT_PREVIEW_URI/);
assert.match(indexSource, /"ui\/resourceUri": ATTACHMENT_PREVIEW_URI/);
assert.match(indexSource, /"email_preview_attachment"/);
assert.match(indexSource, /"email_get_attachment_preview"/);
// The preview tool answers with a token only; it neither reads the mailbox nor sends _meta.
const previewTool = indexSource.slice(
	indexSource.indexOf('"email_preview_attachment",'),
	indexSource.indexOf('"email_get_attachment_preview",'),
);
assert.doesNotMatch(previewTool, /getAttachmentFile|previewImage|_meta: \{[^}]*image/);
// The app-only tool is hidden from the model (host-enforced) and uses structuredContent for the image.
const appTool = indexSource.slice(
	indexSource.indexOf('"email_get_attachment_preview",'),
	indexSource.indexOf('"email_send_previewed_draft",'),
);
assert.match(appTool, /_meta: appOnlyMeta/);

// --- image preparation with a fake Images binding ---
const bytes = (size: number) => new Uint8Array(size).fill(7);
function fakeImages(options: {
	width: number;
	height: number;
	outputSize?: number;
	fail?: boolean;
}) {
	const calls: any[] = [];
	const binding = {
		async info() {
			if (options.fail) throw new Error("boom");
			return {
				format: "image/png",
				fileSize: 1,
				width: options.width,
				height: options.height,
			};
		},
		input() {
			return {
				transform(transform: unknown) {
					calls.push({ transform });
					return this;
				},
				async output(output: unknown) {
					if (options.fail) throw new Error("boom");
					calls.push({ output });
					return { image: () => new Blob([bytes(options.outputSize ?? 1000)]).stream() };
				},
			};
		},
	};
	return { binding: binding as unknown as ImagesBinding, calls };
}

assert.ok(isPreviewImageType("image/PNG; name=x"));
assert.ok(isPreviewImageType("image/jpg"));
assert.ok(!isPreviewImageType("image/svg+xml"));
assert.ok(!isPreviewImageType("application/pdf"));

// Small image within limits: shown unchanged.
const small = fakeImages({ width: 800, height: 600 });
const unchanged = await previewImage(small.binding, "image/png", bytes(5000));
assert.equal(unchanged?.mimeType, "image/png");
assert.equal(unchanged?.resized, false);
assert.equal(unchanged?.base64, Buffer.from(bytes(5000)).toString("base64"));
assert.equal(small.calls.length, 0);

// Large dimensions or bytes: scaled to JPEG, 1024 px, white background, quality 75.
const big = fakeImages({ width: 4000, height: 3000, outputSize: 400_000 });
const scaled = await previewImage(big.binding, "image/png", bytes(6_698_858));
assert.equal(scaled?.mimeType, "image/jpeg");
assert.equal(scaled?.resized, true);
assert.deepEqual(big.calls[0].transform, {
	width: MAX_SIDE,
	height: MAX_SIDE,
	fit: "scale-down",
	background: "#ffffff",
});
assert.equal(big.calls[1].output.format, "image/jpeg");
assert.equal(MAX_SIDE, 1024);
assert.equal(big.calls[1].output.quality, 75);
const heavy = fakeImages({ width: 1000, height: 1000, outputSize: 400_000 });
assert.equal(
	(await previewImage(heavy.binding, "image/webp", bytes(PASS_THROUGH_BYTES + 1)))?.resized,
	true,
);

// Nothing to show: result too large, binding failing, not an image, over the input limit.
assert.equal(
	await previewImage(
		fakeImages({ width: 4000, height: 3000, outputSize: MAX_PREVIEW_BYTES + 1 }).binding,
		"image/png",
		bytes(6_000_000),
	),
	undefined,
);
assert.equal(
	await previewImage(
		fakeImages({ width: 1, height: 1, fail: true }).binding,
		"image/png",
		bytes(10),
	),
	undefined,
);
assert.equal(await previewImage(small.binding, "application/pdf", bytes(10)), undefined);
assert.equal(await previewImage(small.binding, "image/png", bytes(21 * 1024 * 1024)), undefined);
// No binding: only small files are shown unchanged.
assert.equal((await previewImage(undefined, "image/gif", bytes(10)))?.resized, false);
assert.equal(await previewImage(undefined, "image/gif", bytes(PASS_THROUGH_BYTES + 1)), undefined);
console.log("ok");

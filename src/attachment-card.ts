import { shortHash } from "./send-preview-card.ts";

/**
 * Self-contained MCP Apps card for one message attachment. It receives a signed cardToken in
 * the tool result, then fetches the attachment itself with the app-only tool
 * email_get_attachment_preview (like the send card calls its Send/Cancel tools) and shows file
 * name, type, size, the image (inline data: URL, allowed by the default CSP) and a download
 * button that asks the host to open the signed link (ui/open-link).
 * All content is inserted with textContent; the image source is only built from an allowlisted
 * image mime type and a base64 string.
 */
export const ATTACHMENT_PREVIEW_HTML = /* html */ `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Vedlegg</title>
<style>
	:root { color-scheme:light; --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#d9d9d9; --accent:#0b6bcb; --danger:#b3261e; }
	@media (prefers-color-scheme: dark) { :root:not([data-theme]) { color-scheme:dark; --bg:#1e1e1e; --fg:#eee; --muted:#a0a0a0; --line:#3a3a3a; --accent:#5aa9ff; --danger:#ff8a80; } }
	:root[data-theme="dark"] { color-scheme:dark; --bg:#1e1e1e; --fg:#eee; --muted:#a0a0a0; --line:#3a3a3a; --accent:#5aa9ff; --danger:#ff8a80; }
	[hidden] { display:none !important; }
	body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
	h1 { font-size:15px; margin:0 0 4px; overflow-wrap:anywhere; }
	#meta { color:var(--muted); margin:0 0 12px; }
	#imageBox { margin:0 0 12px; text-align:center; border:1px solid var(--line); border-radius:6px; padding:8px; }
	#image { max-width:100%; max-height:600px; object-fit:contain; }
	#note { color:var(--muted); margin:0 0 12px; }
	button { font:inherit; padding:7px 16px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
	#fallback { margin-top:10px; overflow-wrap:anywhere; user-select:all; font-size:12px; }
	#status { margin-top:10px; } .error { color:var(--danger); }
</style>
</head>
<body>
<div id="empty">Venter på vedlegg …</div>
<div id="card" hidden>
	<h1 id="name"></h1>
	<p id="meta"></p>
	<div id="imageBox" hidden><img id="image" alt=""></div>
	<p id="note" hidden></p>
	<button id="download" disabled>Last ned</button>
	<div id="fallback" hidden></div>
</div>
<div id="status" role="status"></div>
<script>
(() => {
	const $ = (id) => document.getElementById(id);
	const pending = new Map();
	let nextId = 1;
	let downloadUrl = null;

	const post = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			post({ id, method, params });
		});
	const setStatus = (message, cls) => { $("status").textContent = message; $("status").className = cls || ""; reportSize(); };

	window.addEventListener("message", (event) => {
		if (event.source !== window.parent) return;
		const message = event.data;
		if (!message || message.jsonrpc !== "2.0") return;
		if (message.id !== undefined && !message.method) {
			const entry = pending.get(message.id);
			if (!entry) return;
			pending.delete(message.id);
			message.error ? entry.reject(new Error(message.error.message || "Forespørsel feilet")) : entry.resolve(message.result);
		} else if (message.method === "ui/notifications/tool-result") {
			render(message.params || {});
		} else if (message.method === "ui/notifications/host-context-changed") {
			applyHostContext(message.params);
		} else if (message.method === "ui/resource-teardown" && message.id !== undefined) {
			post({ id: message.id, result: {} });
		}
	});

	function formatSize(bytes) {
		if (typeof bytes !== "number") return "";
		if (bytes < 1024) return bytes + " B";
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " kB";
		return (bytes / 1024 / 1024).toFixed(1) + " MB";
	}

	function showAttachment(data) {
		$("name").textContent = data.filename || "(uten filnavn)";
		$("meta").textContent = [data.contentType, formatSize(data.size)].filter(Boolean).join(" · ");
		const image = data.image;
		const imageOk = image && /^image\\/(png|jpeg|gif|webp)$/.test(image.mimeType) && /^[A-Za-z0-9+/=]+$/.test(image.base64 || "");
		if (imageOk) {
			$("image").alt = data.filename || "";
			$("image").addEventListener("load", reportSize);
			$("image").src = "data:" + image.mimeType + ";base64," + image.base64;
			$("imageBox").hidden = false;
		} else {
			$("note").textContent = "Forhåndsvisning er ikke tilgjengelig for dette vedlegget.";
			$("note").hidden = false;
		}
		downloadUrl = typeof data.downloadUrl === "string" ? data.downloadUrl : null;
		$("download").disabled = !downloadUrl;
		if (!downloadUrl) setStatus("Mangler nedlastingslenke; be om en ny forhåndsvisning.", "error");
	}

	async function render(result) {
		const data = result.structuredContent || {};
		if (result.isError) {
			setStatus("Kunne ikke vise vedlegget. Se samtalen for detaljer.", "error");
			return;
		}
		$("empty").hidden = true;
		$("card").hidden = false;
		$("name").textContent = "Henter vedlegg …";
		if (typeof data.cardToken !== "string") {
			setStatus("Mangler token fra verktøyet; be om en ny forhåndsvisning.", "error");
			return;
		}
		try {
			const response = await request("tools/call", { name: "email_get_attachment_preview", arguments: { cardToken: data.cardToken } });
			if (response.isError) {
				const detail = (response.content || []).map((c) => c.text).filter(Boolean).join(" ");
				throw new Error(detail || "Verktøyet feilet");
			}
			showAttachment(response.structuredContent || {});
		} catch (error) {
			$("name").textContent = "Vedlegget kunne ikke hentes";
			setStatus(error.message, "error");
		}
		reportSize();
	}

	$("download").addEventListener("click", async () => {
		if (!downloadUrl) return;
		try {
			await request("ui/open-link", { url: downloadUrl });
		} catch (error) {
			$("fallback").textContent = downloadUrl;
			$("fallback").hidden = false;
			setStatus("Kunne ikke åpne lenken automatisk. Kopier den og åpne den i nettleseren (gyldig i 15 minutter).", "error");
		}
	});

	// Theme: the host's hostContext.theme when present, otherwise prefers-color-scheme.
	function applyHostContext(context) {
		if (!context || (context.theme !== "light" && context.theme !== "dark")) return;
		document.documentElement.dataset.theme = context.theme;
	}

	let lastSize = "";
	let sizeReporting = false;
	function reportSize() {
		if (!sizeReporting) return;
		const html = document.documentElement;
		const previous = html.style.height;
		html.style.height = "max-content";
		const height = Math.ceil(html.getBoundingClientRect().height);
		html.style.height = previous;
		const width = Math.ceil(window.innerWidth);
		const key = width + "x" + height;
		if (key === lastSize) return;
		lastSize = key;
		post({ method: "ui/notifications/size-changed", params: { width, height } });
	}
	function startSizeReporting() {
		sizeReporting = true;
		reportSize();
		const observer = new ResizeObserver(reportSize);
		observer.observe(document.documentElement);
		observer.observe(document.body);
	}

	request("ui/initialize", {
		appInfo: { name: "email-attachment-preview", version: "1.0.0" },
		appCapabilities: {},
		protocolVersion: "2026-01-26",
	}).then((result) => {
		applyHostContext(result && result.hostContext);
		post({ method: "ui/notifications/initialized", params: {} });
		startSizeReporting();
	}).catch((error) => setStatus(error.message, "error"));
})();
</script>
</body>
</html>`;

/** Content-versioned like the send card: hosts may cache ui:// resources by URI. */
export const ATTACHMENT_PREVIEW_URI = `ui://email/attachment-preview-${shortHash(ATTACHMENT_PREVIEW_HTML)}.html`;

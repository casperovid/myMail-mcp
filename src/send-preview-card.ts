export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Self-contained MCP Apps view (no SDK dependency) that speaks the SEP-1865 postMessage
 * dialect directly: ui/initialize -> ui/notifications/initialized, then renders the
 * ui/notifications/tool-result of email_preview_send and calls the app-only send/cancel tools.
 * All message content is inserted with textContent; HTML bodies go into a script-less
 * sandboxed iframe.
 */
export const SEND_PREVIEW_HTML = /* html */ `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Godkjenn sending</title>
<style>
	:root { color-scheme:light; --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#d9d9d9; --accent:#0b6bcb; --danger:#b3261e; --ok:#1b7f3b; }
	@media (prefers-color-scheme: dark) { :root:not([data-theme]) { color-scheme:dark; --bg:#1e1e1e; --fg:#eee; --muted:#a0a0a0; --line:#3a3a3a; --accent:#5aa9ff; --danger:#ff8a80; --ok:#6fcf8c; } }
	:root[data-theme="dark"] { color-scheme:dark; --bg:#1e1e1e; --fg:#eee; --muted:#a0a0a0; --line:#3a3a3a; --accent:#5aa9ff; --danger:#ff8a80; --ok:#6fcf8c; }
	body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
	[hidden] { display:none !important; }
	h1 { font-size:15px; margin:0 0 12px; }
	dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:0 0 12px; }
	dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
	.body { white-space:pre-wrap; border:1px solid var(--line); border-radius:6px; padding:10px; max-height:320px; overflow:auto; }
	iframe { display:block; width:100%; height:260px; border:1px solid var(--line); border-radius:6px; background:var(--bg); }
	details { margin-top:10px; }
	.actions { display:flex; gap:8px; margin-top:14px; }
	button { font:inherit; padding:7px 16px; border-radius:6px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
	button.send { background:var(--accent); border-color:var(--accent); color:#fff; }
	button:disabled { opacity:.5; cursor:default; }
	#status { margin-top:10px; } .error { color:var(--danger); } .ok { color:var(--ok); }
</style>
</head>
<body>
<h1>Godkjenn sending av e-post</h1>
<div id="empty">Venter på utkast …</div>
<div id="card" hidden>
	<dl>
		<dt>Fra</dt><dd id="from"></dd>
		<dt>Til</dt><dd id="to"></dd>
		<dt>Kopi</dt><dd id="cc"></dd>
		<dt>Emne</dt><dd id="subject"></dd>
		<dt>Vedlegg</dt><dd id="attachments"></dd>
	</dl>
	<iframe id="htmlFrame" title="E-postinnhold" sandbox="allow-same-origin" referrerpolicy="no-referrer" hidden></iframe>
	<details id="textBox" hidden><summary>Ren tekst</summary><div class="body" id="text"></div></details>
	<div class="body" id="textMain"></div>
	<div class="actions"><button class="send" id="send">Send</button><button id="cancel">Avbryt</button></div>
</div>
<div id="status" role="status"></div>
<script>
(() => {
	const $ = (id) => document.getElementById(id);
	const pending = new Map();
	let nextId = 1;
	let token = null;
	let done = false;
	let htmlBody = "";

	const post = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			post({ id, method, params });
		});
	const setStatus = (message, cls) => { $("status").textContent = message; $("status").className = cls || ""; reportSize(); };
	const setBusy = (busy) => { $("send").disabled = busy || done; $("cancel").disabled = busy || done; };

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

	function render(result) {
		const data = result.structuredContent || {};
		token = (result._meta && result._meta.previewToken) || null;
		if (result.isError || !token) {
			setStatus(result.isError ? "Forhåndsvisningen feilet. Se samtalen for detaljer." : "Mangler godkjenningstoken; be om en ny forhåndsvisning.", "error");
			return;
		}
		$("empty").hidden = true;
		$("card").hidden = false;
		$("from").textContent = data.from || "";
		$("to").textContent = (data.to || []).join(", ");
		$("cc").textContent = (data.cc || []).join(", ") || "–";
		$("subject").textContent = data.subject || "";
		$("attachments").textContent = (data.attachments || []).map((a) => a.filename + " (" + a.size + " B)").join(", ") || "–";
		htmlBody = (result._meta && result._meta.html) || "";
		if (htmlBody) {
			$("text").textContent = data.text || "";
			$("textBox").hidden = false;
			$("textMain").hidden = true;
			$("htmlFrame").hidden = false;
			renderFrame();
		} else {
			$("textMain").textContent = data.text || "";
		}
		if (data.bcc && data.bcc.length) setStatus("Skjult kopi (Bcc): " + data.bcc.join(", "));
		if (data.canSend === false) { $("send").disabled = true; setStatus("SMTP er ikke konfigurert for denne kontoen; sending er utilgjengelig.", "error"); }
		reportSize();
	}

	// The HTML body is shown in a script-less sandbox with the card's own colors as base style.
	// allow-same-origin is only there so the card can measure the content height (no scripts run).
	function renderFrame() {
		if (!htmlBody) return;
		const css = getComputedStyle(document.documentElement);
		const value = (name) => css.getPropertyValue(name).trim();
		const base = "html{color-scheme:" + css.colorScheme + "}body{margin:0;padding:12px;background:" + value("--bg") + ";color:" + value("--fg") + ";font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;overflow-wrap:anywhere}a{color:" + value("--accent") + "}";
		$("htmlFrame").srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; img-src data:; style-src \\'unsafe-inline\\'"><style>' + base + '</style>' + htmlBody;
	}
	function fitFrame() {
		const frame = $("htmlFrame");
		const doc = frame.contentDocument;
		if (!doc || !doc.documentElement) return;
		frame.style.height = "0px";
		const height = Math.min(doc.documentElement.scrollHeight + 2, 600);
		frame.style.height = height + "px";
		reportSize();
	}
	$("htmlFrame").addEventListener("load", fitFrame);
	window.addEventListener("resize", () => { if (htmlBody) fitFrame(); });

	// Theme: the host's hostContext.theme (ui/initialize result and host-context-changed) when
	// present, otherwise prefers-color-scheme.
	function applyHostContext(context) {
		if (!context || (context.theme !== "light" && context.theme !== "dark")) return;
		document.documentElement.dataset.theme = context.theme;
		renderFrame();
	}

	async function act(name, doneMessage, cls) {
		if (!token || done) return;
		setBusy(true);
		try {
			const result = await request("tools/call", { name, arguments: { previewToken: token } });
			const detail = (result.content || []).map((c) => c.text).filter(Boolean).join(" ");
			if (result.isError) throw new Error(detail || "Verktøyet feilet");
			done = true;
			token = null;
			setStatus(doneMessage, cls);
		} catch (error) {
			setStatus(error.message, "error");
		}
		setBusy(false);
	}
	$("send").addEventListener("click", () => act("email_send_previewed_draft", "Sendt.", "ok"));
	$("cancel").addEventListener("click", () => act("email_cancel_previewed_draft", "Avbrutt. Ingenting er sendt.", ""));

	// Same measurement as the official SDK's autoResize: the host sizes a flexible iframe only
	// from ui/notifications/size-changed, so without it the card renders with no height.
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

	// McpUiInitializeRequest params: appInfo, appCapabilities, protocolVersion.
	request("ui/initialize", {
		appInfo: { name: "email-send-preview", version: "1.0.0" },
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

/** FNV-1a (32 bit) as 8 hex characters: a short, synchronous, non-cryptographic content hash. */
export function shortHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Versioned by content: hosts may cache a ui:// resource by URI, so a changed card must get a
 * new URI. Used for the resource registration and both _meta resource links.
 */
export const SEND_PREVIEW_URI = `ui://email/send-preview-${shortHash(SEND_PREVIEW_HTML)}.html`;

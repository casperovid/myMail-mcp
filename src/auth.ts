/**
 * GitHub-based OAuth 2.1 gate that replaces Cloudflare Access.
 *
 * The Worker acts as its own OAuth authorization server for MCP clients
 * (claude.ai, Claude Code) and delegates the human login to GitHub. Only the
 * GitHub account named in ALLOWED_GITHUB_LOGIN gets through, both for MCP
 * clients and for the account management web UI.
 *
 * Client registrations, authorization codes, tokens and sessions are
 * AES-GCM sealed with CREDENTIAL_ENCRYPTION_KEY, so they cannot be forged or
 * read without that key. The only storage used is a short-lived KV marker
 * that makes each authorization code single-use.
 */
import { BASE_PATH, isMcpPath, withBasePath } from "./base-path";
import { bytesToBase64Url, openJson, sealJson } from "./crypto";

interface AuthEnv {
	CREDENTIAL_ENCRYPTION_KEY: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	ALLOWED_GITHUB_LOGIN: string;
	EMAIL_KV: KVNamespace;
}

export interface AuthHandlers {
	mcp: () => Promise<Response> | Response;
	app: () => Promise<Response> | Response;
}

interface Grant {
	c: string; // client_id
	n: string; // client name shown on the consent page
	r: string; // redirect_uri
	cc: string; // PKCE S256 code_challenge
	s?: string; // client state
	sc: string; // scope
}

type Pending = { kind: "ui"; next: string } | { kind: "mcp"; grant: Grant };

const AUTH = withBasePath("/auth");
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 60 * 60 * 24 * 30;
const CODE_TTL = 120;
const PENDING_TTL = 60 * 10;
const SESSION_TTL = 60 * 60 * 12;
const CLIENT_TTL = 60 * 60 * 24 * 365 * 5;
const SESSION_COOKIE = "mymail_session";

const CORS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":
		"Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
	"Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
	"Access-Control-Max-Age": "86400",
};

export async function handleRequest(
	request: Request,
	rawEnv: unknown,
	next: AuthHandlers,
): Promise<Response> {
	const env = rawEnv as AuthEnv;
	const url = new URL(request.url);
	const path = url.pathname;
	const origin = url.origin;
	const method = request.method;

	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.ALLOWED_GITHUB_LOGIN)
		return new Response(
			"Server is missing GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET or ALLOWED_GITHUB_LOGIN",
			{ status: 500 },
		);

	if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

	// Discovery (RFC 8414 / RFC 9728)
	if (
		path === "/.well-known/oauth-authorization-server" ||
		path === `/.well-known/oauth-authorization-server${BASE_PATH}` ||
		path === "/.well-known/openid-configuration"
	)
		return json(authorizationServerMetadata(origin));
	if (
		path === "/.well-known/oauth-protected-resource" ||
		path.startsWith("/.well-known/oauth-protected-resource/")
	)
		return json(protectedResourceMetadata(origin));

	// OAuth endpoints
	if (path === `${AUTH}/register` && method === "POST") return register(request, env);
	if (path === `${AUTH}/authorize` && method === "GET") return authorize(url, env, origin);
	if (path === `${AUTH}/callback` && method === "GET") return githubCallback(url, env, origin);
	if (path === `${AUTH}/approve` && method === "POST") return approve(request, env, origin);
	if (path === `${AUTH}/token` && method === "POST") return token(request, env, origin);
	if (path === `${AUTH}/login` && method === "GET")
		return startGitHubLogin(env, origin, {
			kind: "ui",
			next: safeNext(url.searchParams.get("next")),
		});

	// MCP endpoint: bearer token required
	if (isMcpPath(path)) {
		const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
		if (!match) return unauthorized(origin);
		const claims = await open<{ sub: string; aud: string }>(env, "at", match[1]);
		if (!claims || !isAllowed(claims.sub, env) || claims.aud !== resourceUrl(origin))
			return unauthorized(origin, "invalid_token");
		return next.mcp();
	}

	// Management web UI: GitHub session cookie required
	if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) {
		const session = await open<{ sub: string }>(env, "session", readCookie(request, SESSION_COOKIE));
		if (!session || !isAllowed(session.sub, env)) {
			if (method === "GET" || method === "HEAD")
				return redirect(`${AUTH}/login?next=${encodeURIComponent(path + url.search)}`);
			return new Response("Unauthorized", { status: 401 });
		}
		return next.app();
	}

	return new Response("Not found", { status: 404 });
}

// ---------- metadata ----------

function resourceUrl(origin: string): string {
	return `${origin}${withBasePath("/mcp")}`;
}

function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}${AUTH}/authorize`,
		token_endpoint: `${origin}${AUTH}/token`,
		registration_endpoint: `${origin}${AUTH}/register`,
		response_types_supported: ["code"],
		response_modes_supported: ["query"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		scopes_supported: ["mcp"],
	};
}

function protectedResourceMetadata(origin: string) {
	return {
		resource: resourceUrl(origin),
		authorization_servers: [origin],
		bearer_methods_supported: ["header"],
		scopes_supported: ["mcp"],
		resource_name: "Jobbmail",
	};
}

function unauthorized(origin: string, error?: string): Response {
	const parts = [
		`resource_metadata="${origin}/.well-known/oauth-protected-resource${withBasePath("/mcp")}"`,
	];
	if (error) parts.push(`error="${error}"`);
	return new Response(JSON.stringify({ error: error ?? "unauthorized" }), {
		status: 401,
		headers: {
			...CORS,
			"Content-Type": "application/json",
			"WWW-Authenticate": `Bearer ${parts.join(", ")}`,
		},
	});
}

// ---------- dynamic client registration (RFC 7591) ----------

async function register(request: Request, env: AuthEnv): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return oauthError("invalid_client_metadata", "Body must be JSON");
	}
	const redirectUris = body?.redirect_uris;
	if (
		!Array.isArray(redirectUris) ||
		redirectUris.length === 0 ||
		redirectUris.length > 10 ||
		!redirectUris.every(isValidRedirectUri)
	)
		return oauthError("invalid_redirect_uri", "redirect_uris must be https or loopback URLs");
	const clientName =
		typeof body.client_name === "string" && body.client_name.trim()
			? body.client_name.trim().slice(0, 100)
			: "Ukjent klient";
	const clientId = await seal(env, "client", { r: redirectUris, n: clientName }, CLIENT_TTL);
	return json(
		{
			client_id: clientId,
			client_id_issued_at: now(),
			client_name: clientName,
			redirect_uris: redirectUris,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		},
		201,
	);
}

// ---------- authorization ----------

async function authorize(url: URL, env: AuthEnv, origin: string): Promise<Response> {
	const q = url.searchParams;
	const clientId = q.get("client_id") ?? "";
	const client = await open<{ r: string[]; n: string }>(env, "client", clientId);
	if (!client) return htmlMessage(400, "Ukjent klient. Fjern koblingen i Claude og legg den til på nytt.");

	const redirectUri = q.get("redirect_uri") ?? (client.r.length === 1 ? client.r[0] : "");
	if (!client.r.includes(redirectUri)) return htmlMessage(400, "Ugyldig redirect_uri.");

	const state = q.get("state") ?? undefined;
	if (q.get("response_type") !== "code")
		return redirectWithError(redirectUri, state, "unsupported_response_type");
	const challenge = q.get("code_challenge");
	if (!challenge || q.get("code_challenge_method") !== "S256")
		return redirectWithError(redirectUri, state, "invalid_request", "PKCE with S256 is required");

	const grant: Grant = {
		c: clientId,
		n: client.n,
		r: redirectUri,
		cc: challenge,
		s: state,
		sc: q.get("scope") || "mcp",
	};
	return startGitHubLogin(env, origin, { kind: "mcp", grant });
}

async function startGitHubLogin(env: AuthEnv, origin: string, pending: Pending): Promise<Response> {
	const state = await seal(env, "gh", { p: pending }, PENDING_TTL);
	const target = new URL("https://github.com/login/oauth/authorize");
	target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	target.searchParams.set("redirect_uri", `${origin}${AUTH}/callback`);
	target.searchParams.set("state", state);
	target.searchParams.set("allow_signup", "false");
	return redirect(target.toString());
}

async function githubCallback(url: URL, env: AuthEnv, origin: string): Promise<Response> {
	if (url.searchParams.get("error"))
		return htmlMessage(400, "Innloggingen hos GitHub ble avbrutt.");
	const pendingState = await open<{ p: Pending }>(env, "gh", url.searchParams.get("state"));
	const code = url.searchParams.get("code");
	if (!pendingState || !code)
		return htmlMessage(400, "Innloggingen utløp eller var ugyldig. Prøv på nytt.");

	const login = await fetchGitHubLogin(env, origin, code);
	if (!login) return htmlMessage(502, "Klarte ikke å bekrefte GitHub-kontoen. Prøv på nytt.");
	if (!isAllowed(login, env)) return htmlMessage(403, "Denne GitHub-kontoen har ikke tilgang.");

	const pending = pendingState.p;
	if (pending.kind === "ui") {
		const session = await seal(env, "session", { sub: login }, SESSION_TTL);
		return new Response(null, {
			status: 302,
			headers: {
				Location: safeNext(pending.next),
				"Set-Cookie": `${SESSION_COOKIE}=${session}; Path=${BASE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
				"Cache-Control": "no-store",
			},
		});
	}

	const consent = await seal(env, "consent", { g: pending.grant, sub: login }, PENDING_TTL);
	return consentPage(pending.grant, consent);
}

async function fetchGitHubLogin(
	env: AuthEnv,
	origin: string,
	code: string,
): Promise<string | undefined> {
	try {
		const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "mymail-mcp",
			},
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: `${origin}${AUTH}/callback`,
			}),
		});
		if (!tokenResponse.ok) return undefined;
		const tokenBody = (await tokenResponse.json()) as { access_token?: string };
		if (!tokenBody.access_token) return undefined;

		const userResponse = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${tokenBody.access_token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "mymail-mcp",
			},
		});
		if (!userResponse.ok) return undefined;
		const user = (await userResponse.json()) as { login?: unknown };
		return typeof user.login === "string" ? user.login : undefined;
	} catch {
		return undefined;
	}
}

function consentPage(grant: Grant, consent: string): Response {
	const host = new URL(grant.r).host;
	const html = `<!doctype html>
<html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Godkjenn tilgang</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem;cursor:pointer}
code{background:rgba(127,127,127,.2);padding:.1rem .3rem;border-radius:3px}</style></head>
<body><h1>Gi tilgang til jobbmailen?</h1>
<p><strong>${escapeHtml(grant.n)}</strong> ber om tilgang til å lese, sende og endre e-post via denne serveren.</p>
<p>Tilgangen sendes til <code>${escapeHtml(host)}</code>. Godkjenn bare hvis du selv nettopp startet denne tilkoblingen.</p>
<form method="post" action="${AUTH}/approve">
<input type="hidden" name="consent" value="${escapeHtml(consent)}">
<button type="submit" name="action" value="approve">Godkjenn</button>
<button type="submit" name="action" value="deny">Avbryt</button>
</form></body></html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Frame-Options": "DENY",
			"Content-Security-Policy": "frame-ancestors 'none'",
		},
	});
}

async function approve(request: Request, env: AuthEnv, origin: string): Promise<Response> {
	if (!isSameOriginPost(request, origin)) return htmlMessage(403, "Forbidden");
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return htmlMessage(400, "Ugyldig skjema.");
	}
	const consent = await open<{ g: Grant; sub: string }>(env, "consent", String(form.get("consent") ?? ""));
	if (!consent || !isAllowed(consent.sub, env))
		return htmlMessage(400, "Godkjenningen utløp. Start tilkoblingen på nytt fra Claude.");

	const grant = consent.g;
	if (form.get("action") !== "approve")
		return redirectWithError(grant.r, grant.s, "access_denied", "The user denied access");

	const code = await seal(
		env,
		"code",
		{ g: grant, sub: consent.sub, jti: crypto.randomUUID() },
		CODE_TTL,
	);
	const target = new URL(grant.r);
	target.searchParams.set("code", code);
	if (grant.s) target.searchParams.set("state", grant.s);
	return redirect(target.toString(), 303);
}

// ---------- token endpoint ----------

async function token(request: Request, env: AuthEnv, origin: string): Promise<Response> {
	let params: URLSearchParams;
	try {
		params = await readParams(request);
	} catch {
		return oauthError("invalid_request", "Unreadable request body");
	}
	const clientId = params.get("client_id");
	const grantType = params.get("grant_type");

	if (grantType === "authorization_code") {
		const code = await open<{ g: Grant; sub: string; jti: string }>(env, "code", params.get("code"));
		if (!code) return oauthError("invalid_grant", "Authorization code is invalid or expired");
		const grant = code.g;
		if (clientId && clientId !== grant.c) return oauthError("invalid_grant", "client_id mismatch");
		const redirectUri = params.get("redirect_uri");
		if (redirectUri && redirectUri !== grant.r)
			return oauthError("invalid_grant", "redirect_uri mismatch");
		const verifier = params.get("code_verifier") ?? "";
		if (!verifier || (await sha256Base64Url(verifier)) !== grant.cc)
			return oauthError("invalid_grant", "PKCE verification failed");

		const usedKey = `auth/used-code/${code.jti}`;
		if (await env.EMAIL_KV.get(usedKey))
			return oauthError("invalid_grant", "Authorization code already used");
		await env.EMAIL_KV.put(usedKey, "1", { expirationTtl: 300 });

		return json(await issueTokens(env, origin, code.sub, grant.c, grant.sc));
	}

	if (grantType === "refresh_token") {
		const refresh = await open<{ sub: string; c: string; sc: string }>(
			env,
			"rt",
			params.get("refresh_token"),
		);
		if (!refresh || !isAllowed(refresh.sub, env))
			return oauthError("invalid_grant", "Refresh token is invalid or expired");
		if (clientId && clientId !== refresh.c) return oauthError("invalid_grant", "client_id mismatch");
		return json(await issueTokens(env, origin, refresh.sub, refresh.c, refresh.sc));
	}

	return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

async function issueTokens(env: AuthEnv, origin: string, sub: string, clientId: string, scope: string) {
	return {
		access_token: await seal(env, "at", { sub, aud: resourceUrl(origin) }, ACCESS_TTL),
		token_type: "Bearer",
		expires_in: ACCESS_TTL,
		refresh_token: await seal(env, "rt", { sub, c: clientId, sc: scope }, REFRESH_TTL),
		scope,
	};
}

async function readParams(request: Request): Promise<URLSearchParams> {
	const contentType = request.headers.get("Content-Type") ?? "";
	let params: URLSearchParams;
	if (contentType.includes("application/json")) {
		const body = (await request.json()) as Record<string, unknown>;
		params = new URLSearchParams();
		for (const [key, value] of Object.entries(body ?? {}))
			if (typeof value === "string") params.set(key, value);
	} else {
		params = new URLSearchParams(await request.text());
	}
	// Some clients send client_id via HTTP Basic even when no secret exists.
	const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
	if (basic && !params.get("client_id")) {
		try {
			const [id] = atob(basic[1]).split(":");
			if (id) params.set("client_id", decodeURIComponent(id));
		} catch {
			// ignore malformed Basic header
		}
	}
	return params;
}

// ---------- helpers ----------

function now(): number {
	return Math.floor(Date.now() / 1000);
}

async function seal(
	env: AuthEnv,
	typ: string,
	data: Record<string, unknown>,
	ttl: number,
): Promise<string> {
	return sealJson({ ...data, typ, exp: now() + ttl }, env.CREDENTIAL_ENCRYPTION_KEY);
}

async function open<T>(
	env: AuthEnv,
	typ: string,
	value: string | null | undefined,
): Promise<T | undefined> {
	if (!value) return undefined;
	try {
		const data = await openJson<Record<string, unknown>>(value, env.CREDENTIAL_ENCRYPTION_KEY);
		if (!data || data.typ !== typ || typeof data.exp !== "number" || data.exp < now())
			return undefined;
		return data as unknown as T;
	} catch {
		return undefined;
	}
}

function isAllowed(login: unknown, env: AuthEnv): boolean {
	return (
		typeof login === "string" &&
		login.toLowerCase() === env.ALLOWED_GITHUB_LOGIN.trim().toLowerCase()
	);
}

async function sha256Base64Url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return bytesToBase64Url(new Uint8Array(digest));
}

function isValidRedirectUri(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2000) return false;
	try {
		const parsed = new URL(value);
		if (parsed.hash) return false;
		if (parsed.protocol === "https:") return true;
		return (
			parsed.protocol === "http:" &&
			(parsed.hostname === "localhost" ||
				parsed.hostname === "127.0.0.1" ||
				parsed.hostname === "[::1]")
		);
	} catch {
		return false;
	}
}

function isSameOriginPost(request: Request, origin: string): boolean {
	const requestOrigin = request.headers.get("Origin");
	if (requestOrigin) return requestOrigin === origin;
	const referer = request.headers.get("Referer");
	return !!referer && referer.startsWith(`${origin}/`);
}

function safeNext(next: string | null | undefined): string {
	if (
		typeof next === "string" &&
		(next === BASE_PATH || next.startsWith(`${BASE_PATH}/`) || next.startsWith(`${BASE_PATH}?`)) &&
		!next.startsWith(AUTH) &&
		!next.includes("\\")
	)
		return next;
	return `${BASE_PATH}/`;
}

function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get("Cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return undefined;
}

function redirect(location: string, status = 302): Response {
	return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
}

function redirectWithError(
	redirectUri: string,
	state: string | undefined,
	error: string,
	description?: string,
): Response {
	const target = new URL(redirectUri);
	target.searchParams.set("error", error);
	if (description) target.searchParams.set("error_description", description);
	if (state) target.searchParams.set("state", state);
	return redirect(target.toString());
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			...CORS,
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			Pragma: "no-cache",
		},
	});
}

function oauthError(error: string, description: string, status = 400): Response {
	return json({ error, error_description: description }, status);
}

function htmlMessage(status: number, message: string): Response {
	const html = `<!doctype html><html lang="no"><head><meta charset="utf-8"><title>Jobbmail</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style></head>
<body><p>${escapeHtml(message)}</p></body></html>`;
	return new Response(html, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

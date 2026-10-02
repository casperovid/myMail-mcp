/**
 * Methods this server (via the MCP SDK) handles. Anything else that arrives without an
 * Mcp-Session-Id header would otherwise be rejected by the agents transport with HTTP 400
 * ("Mcp-Session-Id header is required", node_modules/agents/dist/mcp/index.js) before the SDK
 * can answer "Method not found". Clients probing optional methods such as server/discover
 * expect a JSON-RPC error instead of an HTTP failure.
 */
const KNOWN_METHODS = new Set([
	"initialize",
	"ping",
	"tools/list",
	"tools/call",
	"resources/list",
	"resources/templates/list",
	"resources/read",
	"resources/subscribe",
	"resources/unsubscribe",
	"prompts/list",
	"prompts/get",
	"completion/complete",
	"logging/setLevel",
]);

/**
 * Answers a session-less POST carrying a single unknown JSON-RPC method: HTTP 200 with a
 * -32601 error and the request's id, or 202 with no body for a notification (no id).
 * Returns undefined for everything else so the normal transport handles it.
 */
export async function unknownMethodResponse(request: Request): Promise<Response | undefined> {
	if (request.method !== "POST" || request.headers.get("mcp-session-id")) return undefined;
	let message: any;
	try {
		message = JSON.parse(await request.clone().text());
	} catch {
		return undefined;
	}
	if (!message || Array.isArray(message) || typeof message.method !== "string") return undefined;
	if (KNOWN_METHODS.has(message.method)) return undefined;
	if (message.method.startsWith("notifications/") || message.id === undefined)
		return new Response(null, { status: 202 });
	return Response.json(
		{ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } },
		{ status: 200 },
	);
}

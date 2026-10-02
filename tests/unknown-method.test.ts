import assert from "node:assert/strict";
import { unknownMethodResponse } from "../src/unknown-method.ts";

const post = (body: unknown, headers: Record<string, string> = {}) =>
	new Request("https://example.test/myMail/mcp", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

// Unknown method without a session: HTTP 200 + -32601 with the same id (string and number ids).
for (const id of ["server-discover-probe-1", 839548977]) {
	const response = await unknownMethodResponse(
		post({ jsonrpc: "2.0", id, method: "server/discover" }),
	);
	assert.equal(response?.status, 200);
	assert.deepEqual(await response?.json(), {
		jsonrpc: "2.0",
		id,
		error: { code: -32601, message: "Method not found" },
	});
}

// Unknown notification (no id): 202 without a body.
const notification = await unknownMethodResponse(
	post({ jsonrpc: "2.0", method: "server/whatever" }),
);
assert.equal(notification?.status, 202);
assert.equal(await notification?.text(), "");

// Known methods, session-bound requests, non-POST and batches are left to the normal transport.
assert.equal(
	await unknownMethodResponse(post({ jsonrpc: "2.0", id: 1, method: "initialize" })),
	undefined,
);
assert.equal(
	await unknownMethodResponse(post({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
	undefined,
);
assert.equal(
	await unknownMethodResponse(
		post({ jsonrpc: "2.0", id: 1, method: "server/discover" }, { "mcp-session-id": "abc" }),
	),
	undefined,
);
assert.equal(
	await unknownMethodResponse(post([{ jsonrpc: "2.0", id: 1, method: "server/discover" }])),
	undefined,
);
assert.equal(
	await unknownMethodResponse(new Request("https://example.test/myMail/mcp", { method: "GET" })),
	undefined,
);
console.log("ok");

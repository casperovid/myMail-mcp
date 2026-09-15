import assert from "node:assert/strict";
import test from "node:test";
import { BASE_PATH, isMcpPath, withBasePath } from "../src/base-path.ts";

test("withBasePath prefixes application-absolute paths", () => {
	assert.equal(withBasePath("/"), `${BASE_PATH}/`);
	assert.equal(withBasePath("/accounts"), `${BASE_PATH}/accounts`);
	assert.equal(withBasePath("/?status=removed"), `${BASE_PATH}/?status=removed`);
});

test("withBasePath rejects a relative path rather than silently mis-mounting it", () => {
	assert.throws(() => withBasePath("accounts"), /expected an absolute path/);
});

test("isMcpPath matches the mounted MCP endpoint and its subpaths only", () => {
	assert.equal(isMcpPath(`${BASE_PATH}/mcp`), true);
	assert.equal(isMcpPath(`${BASE_PATH}/mcp/messages`), true);
	assert.equal(isMcpPath(`${BASE_PATH}/`), false);
	assert.equal(isMcpPath(`${BASE_PATH}/accounts`), false);
	// A bare /mcp must not match: that path is not routed to this Worker.
	assert.equal(isMcpPath("/mcp"), false);
	// Guard against a prefix-collision route such as /mcp-admin.
	assert.equal(isMcpPath(`${BASE_PATH}/mcp-admin`), false);
});

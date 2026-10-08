import assert from "node:assert/strict";
import { diagnoseBearer } from "../src/bearer-diagnosis.ts";
import { sealJson } from "../src/crypto.ts";

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const otherKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const aud = "https://mcp.example.test/myMail/mcp";
const now = 1_000_000;
const allowed = (login: unknown) => login === "me";
const bearer = async (claims: Record<string, unknown>, k = key) =>
	`Bearer ${await sealJson(claims, k)}`;
const check = (header: string | null) => diagnoseBearer(header, key, aud, allowed, now);
const good = { typ: "at", sub: "me", aud, exp: now + 60 };

assert.equal(await check(null), "no_token");
assert.equal(await check("Basic abc"), "no_token");
assert.equal(await check("Bearer garbage"), "invalid_token");
assert.equal(await check(await bearer(good, otherKey)), "invalid_token");
assert.equal(await check(await bearer({ ...good, typ: "rt" })), "wrong_token_type");
assert.equal(await check(await bearer({ ...good, exp: now - 1 })), "expired");
assert.equal(await check(await bearer({ ...good, sub: "someone" })), "not_allowed");
assert.equal(
	await check(await bearer({ ...good, aud: "https://other.test/mcp" })),
	"wrong_audience",
);
assert.equal(await check(await bearer(good)), undefined);
console.log("ok");

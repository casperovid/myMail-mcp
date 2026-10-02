import assert from "node:assert/strict";
import { findDraftMismatches } from "../src/mail/draft-verify.ts";

const draft = { to: ["A@x.com"], cc: [], subject: "Hi  there", text: "Line1\r\nLine2  end\n" };
assert.deepEqual(
	findDraftMismatches({ to: "a@x.com", subject: "Hi there", text: "Line1 Line2 end" }, draft),
	[],
);
const bad = findDraftMismatches(
	{ to: ["b@x.com"], cc: "c@x.com", subject: "Hi", text: "Line1 Line2 end!" },
	draft,
);
assert.equal(bad.length, 4);
console.log("ok");

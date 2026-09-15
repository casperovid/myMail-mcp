import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// This repository is public, so guard against committing anything that actually
// grants access. Deployment identifiers (the KV namespace ID, the Access team
// domain and audience) are intentionally committed in wrangler.toml: they are
// inert without account credentials, and keeping them in one tracked file avoids
// a build-time codegen step whose only purpose was hiding them.
//
// What must never land in the repository is a credential: the account ID, the
// AES key that decrypts stored mailbox passwords, and the Outlook client secret.

const wrangler = await readFile("wrangler.toml", "utf8");
const workerTypes = await readFile("worker-configuration.d.ts", "utf8");
const gitignore = await readFile(".gitignore", "utf8");

assert.doesNotMatch(wrangler, /^\s*account_id\s*=/m, "wrangler.toml must not contain account_id");
assert.doesNotMatch(
	wrangler,
	/^\s*CREDENTIAL_ENCRYPTION_KEY\s*=/m,
	"CREDENTIAL_ENCRYPTION_KEY is a secret and must be set in the dashboard, not wrangler.toml",
);
assert.doesNotMatch(
	wrangler,
	/^\s*OUTLOOK_CLIENT_SECRET\s*=/m,
	"OUTLOOK_CLIENT_SECRET is a secret and must be set in the dashboard, not wrangler.toml",
);
assert.doesNotMatch(
	workerTypes,
	/CREDENTIAL_ENCRYPTION_KEY:\s*"/,
	"generated Worker types must not contain a literal encryption key",
);
assert.doesNotMatch(
	workerTypes,
	/OUTLOOK_CLIENT_SECRET:\s*"/,
	"generated Worker types must not contain a literal Outlook client secret",
);
assert.match(gitignore, /^\.dev\.vars$/m, "local .dev.vars secrets must be ignored");

console.log("No credentials are committed to the public repository.");

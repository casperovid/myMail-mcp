/**
 * Deploy the Worker, promoting build secrets to runtime secrets.
 *
 * Workers Builds exposes "Build → Variables and secrets" to the deploy
 * command's environment, but those values are build-time only: they are not
 * bound to the running Worker. This Worker needs CREDENTIAL_ENCRYPTION_KEY at
 * request time to decrypt stored mailbox credentials.
 *
 * `wrangler deploy --secrets-file` uploads secrets with the same request that
 * uploads the code, so the build-time value becomes a runtime secret. Secrets
 * absent from the file are preserved from the previous version.
 *
 * The file is written to a private temporary path and removed afterwards so a
 * plaintext secret never lands in the repository or the build output.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Secrets promoted from the build environment, when present. */
const PROMOTED = ["CREDENTIAL_ENCRYPTION_KEY", "OUTLOOK_CLIENT_SECRET"];

function collectSecrets(environment) {
	const secrets = {};
	for (const name of PROMOTED) {
		const value = environment[name]?.trim();
		if (value) secrets[name] = value;
	}
	return secrets;
}

function assertUsableEncryptionKey(secrets) {
	const key = secrets.CREDENTIAL_ENCRYPTION_KEY;
	if (!key)
		throw new Error(
			"CREDENTIAL_ENCRYPTION_KEY is not set. Add it under Settings -> Build -> " +
				"Variables and secrets; this script promotes it to a runtime secret at deploy time.",
		);
	// Mirror the runtime check in src/crypto.ts so a bad paste fails the deploy
	// rather than every mailbox operation afterwards.
	let decoded;
	try {
		decoded = Buffer.from(key, "base64");
	} catch {
		throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
	}
	if (decoded.byteLength !== 32)
		throw new Error(
			`CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes, got ${decoded.byteLength}`,
		);
}

const passthrough = process.argv.slice(2);
const secrets = collectSecrets(process.env);
try {
	assertUsableEncryptionKey(secrets);
} catch (error) {
	// A configuration mistake deserves a readable line, not a stack trace.
	console.error(`Deploy aborted: ${error.message}`);
	process.exit(1);
}

// --dry-run never contacts the API, so there is nothing to upload secrets to.
const dryRun = passthrough.includes("--dry-run");
const directory = dryRun ? undefined : mkdtempSync(join(tmpdir(), "mymail-deploy-"));
const secretsPath = directory ? join(directory, "secrets.json") : undefined;

try {
	const args = ["wrangler", "deploy", ...passthrough];
	if (secretsPath) {
		writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
		args.push("--secrets-file", secretsPath);
	}
	console.log(
		`Deploying with ${Object.keys(secrets).length} runtime secret(s): ${Object.keys(secrets).join(", ")}`,
	);
	const result = spawnSync("npx", args, { stdio: "inherit" });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	if (directory) rmSync(directory, { recursive: true, force: true });
}

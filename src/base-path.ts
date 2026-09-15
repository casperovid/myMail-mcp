/**
 * Mount point for this Worker within the shared MCP hub hostname.
 *
 * The Worker is routed at `<hub-host>/myMail*`, so every path the Worker
 * matches, redirects to, or emits into HTML has to carry this prefix. Paths
 * that reach the Worker already include it; paths the Worker *produces* do
 * not, which is what `withBasePath` is for.
 *
 * Set to "" to serve the Worker from the root of its own hostname instead.
 */
export const BASE_PATH = "/myMail";

/** Prefix an application-absolute path with the mount point. */
export function withBasePath(path: string): string {
	if (!path.startsWith("/")) throw new Error(`expected an absolute path, got ${path}`);
	return `${BASE_PATH}${path}`;
}

/** True when the request targets this Worker's MCP endpoint. */
export function isMcpPath(pathname: string): boolean {
	const mcp = withBasePath("/mcp");
	return pathname === mcp || pathname.startsWith(`${mcp}/`);
}

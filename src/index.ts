import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { McpAgent } from "agents/mcp";

import { isMcpPath, withBasePath } from "./base-path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { accessRejection } from "./access";
import app from "./app";
import { AccountStore } from "./mail/account-store";
import { MailService } from "./mail/mail-service";
import type { MailEnv } from "./mail/types";
import { observeTool, safeErrorCategory } from "./observability";
import {
	attachmentDisposition,
	createAttachmentLink,
	createAttachmentToken,
	DOWNLOAD_PREFIX,
	openAttachmentLink,
} from "./attachment-link";
import { MCP_APP_MIME_TYPE, SEND_PREVIEW_HTML, SEND_PREVIEW_URI } from "./send-preview-card";
import { ATTACHMENT_PREVIEW_HTML, ATTACHMENT_PREVIEW_URI } from "./attachment-card";
import { previewImage } from "./attachment-image";
import { cancelApproval, consumeApproval, putApproval } from "./send-approval";

const accountSelector = {
	accountId: z
		.string()
		.optional()
		.describe(
			"Configured account ID returned by email_list_accounts; optional only when exactly one account exists.",
		),
};

const accountIdsSelector = {
	accountIds: z
		.array(z.string())
		.min(1)
		.optional()
		.describe(
			"Optional selected configured account IDs returned by email_list_accounts; omit to search or check all configured accounts.",
		),
};

const attachmentSchema = z.object({
	filename: z.string().min(1).describe("Attachment filename to include on the draft."),
	contentType: z.string().min(1).describe("Attachment MIME type, for example application/pdf."),
	contentBase64: z
		.string()
		.min(1)
		.describe("Raw attachment bytes encoded as base64; not for message text or HTML."),
});

const recipientSchema = z.union([z.string().email(), z.array(z.string().email()).min(1)]);
const optionalRecipientSchema = z.union([z.string().email(), z.array(z.string().email())]);
const replyToSchema = z
	.string()
	.email()
	.describe("Optional Reply-To email address to include on the draft for recipient replies.");

const uidSchema = z.union([
	z.number().int().positive(),
	z.array(z.number().int().positive()).min(1).max(100),
]);

const serverConfigOutput = z.object({
	host: z.string(),
	port: z.number().int(),
	secure: z.boolean(),
});

const capabilitiesOutput = z.object({
	imap: z.boolean(),
	smtp: z.boolean(),
	canSend: z.boolean(),
});

const messageSummaryOutput = z.object({
	accountId: z.string(),
	folder: z.string(),
	uid: z.number().int(),
	messageId: z.string().optional(),
	inReplyTo: z.string().optional(),
	references: z.array(z.string()),
	threadId: z.string().optional(),
	subject: z.string(),
	from: z.string(),
	to: z.string(),
	cc: z.string(),
	date: z.string().optional(),
	flags: z.array(z.string()),
});

const multiAccountMessageSummaryOutput = messageSummaryOutput.extend({
	accountName: z.string(),
	accountEmail: z.string(),
});

const multiAccountSearchOutput = {
	status: z.literal("ok"),
	outcome: z.enum(["no_matches", "matches_found"]),
	count: z.number().int(),
	total: z.number().int(),
	empty: z.boolean(),
	succeeded: z.number().int(),
	failed: z.number().int(),
	message: z.string(),
	accounts: z.array(
		z.object({
			accountId: z.string(),
			accountName: z.string(),
			accountEmail: z.string(),
			ok: z.boolean(),
			folder: z.string(),
			count: z.number().int(),
			total: z.number().int(),
			nextCursor: z.string().optional(),
			error: z.string().optional(),
		}),
	),
	messages: z.array(multiAccountMessageSummaryOutput),
};

const draftLocationOutput = {
	accountId: z.string(),
	folder: z.string(),
	uid: z.number().int(),
	messageId: z.string(),
};

const localWrite = annotations(false, false, false, false);
const localDelete = annotations(false, true, false, false);
const remoteRead = annotations(true, false, true, true);
const remoteUpdate = annotations(false, false, true, true);
const remoteCreate = annotations(false, false, false, true);
const remoteMove = annotations(false, true, false, true);
const remoteDelete = annotations(false, true, true, true);
const remoteSend = annotations(false, true, false, true);

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export class MyMCP extends McpAgent<MailEnv> {
	server = new McpServer({ name: "email-mcp-server", version: "1.0.0" });

	async init() {
		const env = (this as unknown as { env: MailEnv }).env;
		const store = new AccountStore(env.EMAIL_KV, env.CREDENTIAL_ENCRYPTION_KEY);
		const mail = new MailService(store, {
			clientId: env.OUTLOOK_CLIENT_ID,
			clientSecret: env.OUTLOOK_CLIENT_SECRET,
		});
		const registerTools = (
			names: string[],
			config: any,
			handler: (toolName: string) => any,
		) => {
			for (const name of names) this.server.registerTool(name, config, handler(name));
		};

		this.server.registerTool(
			"email_add_account",
			{
				description:
					"Add, configure, or connect a Gmail, Outlook, iCloud, Yahoo, or custom IMAP email account. Stores encrypted credentials and returns the new account ID and send capabilities. IMAP is required; SMTP is optional. Do not use to search, read, move, send, or delete messages.",
				inputSchema: {
					name: z
						.string()
						.describe(
							"Display name for this configured account, shown in list and search results.",
						),
					email: z
						.string()
						.email()
						.describe("Email address for this configured account."),
					imapHost: z.string().describe("IMAP host used to read folders and messages."),
					imapPort: z.number().int().default(993).describe("IMAP port; defaults to 993."),
					imapSecure: z
						.boolean()
						.default(true)
						.describe("Whether IMAP uses TLS; defaults to true."),
					smtpHost: z
						.string()
						.optional()
						.describe(
							"Optional SMTP host used to send drafts; omit for a read-only account.",
						),
					smtpPort: z
						.number()
						.int()
						.optional()
						.describe("Optional SMTP port; defaults to 465 when smtpHost is provided."),
					smtpSecure: z
						.boolean()
						.default(true)
						.describe("Whether SMTP uses TLS; defaults to true."),
					password: z
						.string()
						.optional()
						.describe("Password or app password for IMAP/SMTP authentication."),
					accessToken: z
						.string()
						.optional()
						.describe("OAuth2 access token for IMAP/SMTP authentication."),
					refreshToken: z
						.string()
						.optional()
						.describe("Optional OAuth2 refresh token used to renew accessToken."),
					oauthClientId: z
						.string()
						.optional()
						.describe(
							"Optional OAuth2 client ID used when refreshing OAuth2 credentials.",
						),
					oauthTenant: z
						.string()
						.default("consumers")
						.describe("OAuth2 tenant identifier; defaults to consumers."),
					tokenExpiresAt: z
						.number()
						.optional()
						.describe(
							"Optional epoch timestamp in milliseconds when accessToken expires.",
						),
				},
				outputSchema: {
					id: z.string(),
					name: z.string(),
					email: z.string(),
					capabilities: capabilitiesOutput,
				},
				annotations: titled("Add Email Account", localWrite),
			},
			async (input) =>
				observeTool("email_add_account", async () => {
					if (!input.password && !input.accessToken) {
						throw new Error("Provide either password or accessToken");
					}
					if (!input.smtpHost && input.smtpPort)
						throw new Error("smtpHost is required when smtpPort is provided");
					const account = await store.add({
						name: input.name,
						email: input.email,
						imap: {
							host: input.imapHost,
							port: input.imapPort,
							secure: input.imapSecure,
						},
						smtp: input.smtpHost
							? {
									host: input.smtpHost,
									port: input.smtpPort ?? 465,
									secure: input.smtpSecure,
								}
							: undefined,
						auth: input.password
							? { type: "password", password: input.password }
							: {
									type: "oauth2",
									accessToken: input.accessToken!,
									refreshToken: input.refreshToken,
									clientId: input.oauthClientId,
									tenant: input.oauthTenant,
									expiresAt: input.tokenExpiresAt,
								},
					});
					return text({
						id: account.id,
						name: account.name,
						email: account.email,
						capabilities: {
							imap: true,
							smtp: Boolean(account.smtp),
							canSend: Boolean(account.smtp),
						},
					});
				}),
		);

		this.server.registerTool(
			"email_list_accounts",
			{
				description:
					"List, show, or lookup configured email accounts. Returns account IDs, names, email addresses, connection settings, auth type, and whether sending is available without exposing credentials. Use this before tools that require accountId. Do not use to search or read messages.",
				inputSchema: {},
				outputSchema: {
					accounts: z.array(
						z.object({
							id: z.string(),
							name: z.string(),
							email: z.string(),
							imap: serverConfigOutput,
							smtp: serverConfigOutput.optional(),
							capabilities: capabilitiesOutput,
							authType: z.enum(["password", "oauth2"]),
						}),
					),
				},
				annotations: titled("List Email Accounts", annotations(true, false, true, false)),
			},
			async () =>
				observeTool("email_list_accounts", async () => {
					const accounts = await store.list();
					const result = accounts.map(({ id, name, email, imap, smtp, auth }) => ({
						id,
						name,
						email,
						imap,
						smtp,
						capabilities: {
							imap: true,
							smtp: Boolean(smtp),
							canSend: Boolean(smtp),
						},
						authType: auth.type,
					}));
					return text(result, { accounts: result });
				}),
		);

		this.server.registerTool(
			"email_remove_account",
			{
				description:
					"Remove or delete a configured account from this MCP server and discard its encrypted credentials. Side effect: removes only the local account configuration; it does not delete mailbox messages from the provider.",
				inputSchema: {
					accountId: z
						.string()
						.describe("Configured account ID returned by email_list_accounts."),
				},
				outputSchema: { removed: z.string() },
				annotations: titled("Remove Email Account", localDelete),
			},
			async ({ accountId }) =>
				observeTool("email_remove_account", async () => {
					await store.remove(accountId);
					return text({ removed: accountId });
				}),
		);

		this.server.registerTool(
			"email_test_connection",
			{
				description:
					"Test, check, or verify a configured account connection by authenticating to IMAP and, when SMTP is configured, SMTP. Returns connection capabilities and send availability. Use for troubleshooting account setup; do not use to list folders or search messages.",
				inputSchema: accountSelector,
				outputSchema: {
					connected: z.boolean(),
					accountId: z.string(),
					email: z.string(),
					capabilities: z.array(z.string()),
					smtpConfigured: z.boolean(),
					smtpConnected: z.boolean().optional(),
				},
				annotations: titled("Test Email Connection", remoteRead),
			},
			async ({ accountId }) =>
				observeTool("email_test_connection", async () =>
					text(await mail.testConnection(accountId)),
				),
		);

		this.server.registerTool(
			"email_list_folders",
			{
				description:
					"List, show, or lookup exact IMAP folder paths and special-use flags for one configured account. Returns folder path, display name, and flags. Use before status, search, move, trash, or delete when the exact folder is not known; does not return message summaries or message contents.",
				inputSchema: accountSelector,
				outputSchema: {
					folders: z.array(
						z.object({
							path: z.string(),
							name: z.string(),
							flags: z.array(z.string()),
						}),
					),
				},
				annotations: titled("List Email Folders", remoteRead),
			},
			async ({ accountId }) =>
				observeTool("email_list_folders", async () => {
					const folders = await mail.listFolders(accountId);
					return text(folders, { folders });
				}),
		);

		registerTools(
			["email_get_mailbox_status"],
			{
				description:
					"Get, check, or show mailbox counts for one account and one folder. Requires an accountId when multiple accounts exist and an exact folder path from email_list_folders; defaults to INBOX. Returns message totals, unread counts, recent counts, UIDNEXT, and UIDVALIDITY. Read-only; do not use to find message summaries or full message contents.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
				},
				outputSchema: {
					accountId: z.string(),
					folder: z.string(),
					messages: z.number().int(),
					unseen: z.number().int(),
					recent: z.number().int(),
					uidNext: z.number().int().optional(),
					uidValidity: z.number().int().optional(),
				},
				annotations: titled("Get Mailbox Status", remoteRead),
			},
			(toolName) =>
				async ({ accountId, folder }: any) =>
					observeTool(toolName, async () =>
						text(await mail.mailboxStatus(accountId, folder)),
					),
		);

		registerTools(
			["email_get_all_account_mailbox_statuses"],
			{
				description:
					"Get, check, or show mailbox counts for all configured accounts or selected accountIds in one folder. Defaults to INBOX and returns per-account message totals, unread counts, recent counts, UIDNEXT, UIDVALIDITY, and per-account errors. Read-only; do not use to search message summaries or get full message contents.",
				inputSchema: {
					...accountIdsSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
				},
				outputSchema: {
					status: z.literal("ok"),
					count: z.number().int(),
					succeeded: z.number().int(),
					failed: z.number().int(),
					accounts: z.array(
						z.object({
							accountId: z.string(),
							accountName: z.string(),
							accountEmail: z.string(),
							ok: z.boolean(),
							folder: z.string(),
							messages: z.number().int().optional(),
							unseen: z.number().int().optional(),
							recent: z.number().int().optional(),
							uidNext: z.number().int().optional(),
							uidValidity: z.number().int().optional(),
							error: z.string().optional(),
						}),
					),
				},
				annotations: titled("Get All Mailbox Statuses", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.mailboxStatusAll(input))),
		);

		registerTools(
			["email_search_messages"],
			{
				description:
					"Find, search, lookup, locate, or show message summaries in one account and one folder using sender, recipient, subject, keywords, dates, size, flags, Message-ID, or free text filters. Returns message summaries with accountId, folder, IMAP UID, headers, dates, flags, counts, and nextCursor. Use before get, move, archive, trash, permanently delete, or flag updates when you do not already know the IMAP UID. Do not use to retrieve full message contents.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					from: z
						.string()
						.optional()
						.describe("Find messages from this sender address or text."),
					to: z
						.string()
						.optional()
						.describe("Find messages sent to this recipient address or text."),
					cc: z
						.string()
						.optional()
						.describe("Find messages with this Cc recipient address or text."),
					bcc: z
						.string()
						.optional()
						.describe("Find messages with this Bcc recipient address or text."),
					subject: z
						.string()
						.optional()
						.describe("Find messages whose Subject header contains this text."),
					body: z
						.string()
						.optional()
						.describe("Find messages whose body contains this text."),
					text: z
						.string()
						.optional()
						.describe(
							"Find messages containing this text anywhere in message headers or body.",
						),
					messageId: z
						.string()
						.optional()
						.describe(
							"Find messages by exact or partial Message-ID header; this is not an IMAP UID.",
						),
					since: z
						.string()
						.optional()
						.describe(
							"Find messages with internal mailbox date on or after this ISO date.",
						),
					before: z
						.string()
						.optional()
						.describe("Find messages with internal mailbox date before this ISO date."),
					on: z
						.string()
						.optional()
						.describe("Find messages with this exact internal mailbox ISO date."),
					sentSince: z
						.string()
						.optional()
						.describe("Find messages whose Date header is on or after this ISO date."),
					sentBefore: z
						.string()
						.optional()
						.describe("Find messages whose Date header is before this ISO date."),
					seen: z
						.enum(["any", "seen", "unseen"])
						.default("any")
						.describe("Filter by read state: any, seen, or unseen."),
					flagged: z
						.enum(["any", "flagged", "unflagged"])
						.default("any")
						.describe("Filter by flagged state: any, flagged, or unflagged."),
					answered: z
						.enum(["any", "answered", "unanswered"])
						.default("any")
						.describe(
							"Filter by answered/replied state: any, answered, or unanswered.",
						),
					draft: z
						.enum(["any", "draft", "not_draft"])
						.default("any")
						.describe("Filter by draft state: any, draft, or not_draft."),
					deleted: z
						.enum(["any", "deleted", "not_deleted"])
						.default("any")
						.describe("Filter by IMAP deleted state: any, deleted, or not_deleted."),
					keyword: z
						.string()
						.regex(/^[A-Za-z0-9$][A-Za-z0-9$._-]*$/)
						.optional()
						.describe("Find messages with this IMAP keyword or provider label."),
					largerThan: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Find messages larger than this minimum size in bytes."),
					smallerThan: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Find messages smaller than this maximum size in bytes."),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(25)
						.describe("Maximum number of message summaries to return, from 1 to 100."),
					cursor: z
						.string()
						.optional()
						.describe(
							"Opaque nextCursor returned by the previous identical email_search_messages call.",
						),
					sortOrder: z
						.enum(["newest", "oldest"])
						.default("newest")
						.describe("Order message summaries by message date: newest or oldest."),
				},
				outputSchema: {
					status: z.literal("ok"),
					outcome: z.enum(["no_matches", "matches_found"]),
					accountId: z.string(),
					folder: z.string(),
					count: z.number().int(),
					total: z.number().int(),
					empty: z.boolean(),
					cursor: z.string().optional(),
					nextCursor: z.string().optional(),
					message: z.string(),
					messages: z.array(messageSummaryOutput),
				},
				annotations: titled("Search Email", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.search(input))),
		);

		registerTools(
			["email_search_all_accounts"],
			{
				description:
					"Find, search, lookup, locate, or show message summaries across all configured accounts or selected accountIds in one folder using sender, recipient, subject, keywords, dates, size, flags, Message-ID, or free text filters. Returns a flat message summary list with account identity plus per-account totals, nextCursor values, and errors. Use before get, move, archive, trash, permanently delete, or flag updates when you do not already know the accountId, folder, and IMAP UID. Do not use to retrieve full message contents.",
				inputSchema: {
					...accountIdsSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					from: z
						.string()
						.optional()
						.describe("Find messages from this sender address or text."),
					to: z
						.string()
						.optional()
						.describe("Find messages sent to this recipient address or text."),
					cc: z
						.string()
						.optional()
						.describe("Find messages with this Cc recipient address or text."),
					bcc: z
						.string()
						.optional()
						.describe("Find messages with this Bcc recipient address or text."),
					subject: z
						.string()
						.optional()
						.describe("Find messages whose Subject header contains this text."),
					body: z
						.string()
						.optional()
						.describe("Find messages whose body contains this text."),
					text: z
						.string()
						.optional()
						.describe(
							"Find messages containing this text anywhere in message headers or body.",
						),
					messageId: z
						.string()
						.optional()
						.describe(
							"Find messages by exact or partial Message-ID header; this is not an IMAP UID.",
						),
					since: z
						.string()
						.optional()
						.describe(
							"Find messages with internal mailbox date on or after this ISO date.",
						),
					before: z
						.string()
						.optional()
						.describe("Find messages with internal mailbox date before this ISO date."),
					on: z
						.string()
						.optional()
						.describe("Find messages with this exact internal mailbox ISO date."),
					sentSince: z
						.string()
						.optional()
						.describe("Find messages whose Date header is on or after this ISO date."),
					sentBefore: z
						.string()
						.optional()
						.describe("Find messages whose Date header is before this ISO date."),
					seen: z
						.enum(["any", "seen", "unseen"])
						.default("any")
						.describe("Filter by read state: any, seen, or unseen."),
					flagged: z
						.enum(["any", "flagged", "unflagged"])
						.default("any")
						.describe("Filter by flagged state: any, flagged, or unflagged."),
					answered: z
						.enum(["any", "answered", "unanswered"])
						.default("any")
						.describe(
							"Filter by answered/replied state: any, answered, or unanswered.",
						),
					draft: z
						.enum(["any", "draft", "not_draft"])
						.default("any")
						.describe("Filter by draft state: any, draft, or not_draft."),
					deleted: z
						.enum(["any", "deleted", "not_deleted"])
						.default("any")
						.describe("Filter by IMAP deleted state: any, deleted, or not_deleted."),
					keyword: z
						.string()
						.regex(/^[A-Za-z0-9$][A-Za-z0-9$._-]*$/)
						.optional()
						.describe("Find messages with this IMAP keyword or provider label."),
					largerThan: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Find messages larger than this minimum size in bytes."),
					smallerThan: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Find messages smaller than this maximum size in bytes."),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(25)
						.describe(
							"Maximum number of message summaries to return per selected account, from 1 to 100.",
						),
					sortOrder: z
						.enum(["newest", "oldest"])
						.default("newest")
						.describe(
							"Order message summaries by message date within each account: newest or oldest.",
						),
				},
				outputSchema: multiAccountSearchOutput,
				annotations: titled("Search All Email", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.searchAll(input))),
		);

		registerTools(
			["email_list_all_inbox_messages"],
			{
				description:
					"List, show, lookup, or check message summaries from INBOX across all configured email accounts or selected accountIds. Returns the newest inbox message summaries by default with accountId, accountName, accountEmail, folder, IMAP UID, headers, dates, flags, per-account totals, nextCursor values, and per-account errors. Read-only. Use this for a quick all-inboxes view; use email_search_all_accounts when you need filters or a folder other than INBOX.",
				inputSchema: {
					...accountIdsSelector,
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(25)
						.describe(
							"Maximum number of INBOX message summaries to return per selected account, from 1 to 100.",
						),
					sortOrder: z
						.enum(["newest", "oldest"])
						.default("newest")
						.describe(
							"Order INBOX message summaries by message date within each account: newest or oldest.",
						),
				},
				outputSchema: multiAccountSearchOutput,
				annotations: titled("List All Inbox Messages", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.listAllInboxes(input))),
		);

		registerTools(
			["email_get_message_attachment"],
			{
				description:
					"Get a download link for one attachment of a message. Requires accountId when needed, exact folder path, IMAP UID, and attachmentIndex returned by email_get_message. Returns downloadUrl (a signed link to the original file that expires after 15 minutes and can be opened several times until then) and expiresAt. Claude does not receive the file contents: give the link to the user to open or download. The link is not validated when created; an invalid message or index gives a 404 at download. Do not use to get message text, HTML, or to search for messages.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: z
						.number()
						.int()
						.positive()
						.describe(
							"IMAP UID returned by search/get/thread results; not the email Message-ID header.",
						),
					attachmentIndex: z
						.number()
						.int()
						.nonnegative()
						.describe("Zero-based attachmentIndex returned by email_get_message."),
				},
				outputSchema: {
					accountId: z.string().optional(),
					folder: z.string(),
					uid: z.number().int(),
					attachmentIndex: z.number().int(),
					downloadUrl: z.string(),
					expiresAt: z.string(),
				},
				annotations: titled("Get Email Attachment Download Link", remoteRead),
			},
			(toolName) =>
				async ({ accountId, folder, uid, attachmentIndex }: any) =>
					observeTool(toolName, async () =>
						text({
							accountId,
							folder,
							uid,
							attachmentIndex,
							...(await createAttachmentLink(env, {
								accountId,
								folder,
								uid,
								attachmentIndex,
							})),
						}),
					),
		);

		registerTools(
			["email_get_message"],
			{
				description:
					"Get, retrieve, open, read, or show the full contents of one email message. Requires accountId when needed plus exact folder path and IMAP UID returned by email_search_messages, email_search_all_accounts, or email_get_message_thread. Returns headers, text, HTML, flags, and attachment indexes. Do not use for searching or locating unknown messages.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: z
						.number()
						.int()
						.describe(
							"IMAP UID returned by search/get/thread results; not the email Message-ID header.",
						),
				},
				outputSchema: {
					accountId: z.string(),
					uid: z.number().int(),
					messageId: z.string().optional(),
					inReplyTo: z.string().optional(),
					references: z.array(z.string()),
					threadId: z.string().optional(),
					subject: z.string().optional(),
					from: z.string().optional(),
					to: z.unknown().optional(),
					cc: z.unknown().optional(),
					date: z.string().optional(),
					text: z.string().optional(),
					html: z.string().optional(),
					attachments: z.array(
						z.object({
							attachmentIndex: z.number().int(),
							filename: z.string().optional(),
							contentType: z.string(),
							size: z.number().int(),
						}),
					),
					flags: z.array(z.string()),
				},
				annotations: titled("Get Email", remoteRead),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () =>
					text(await mail.getMessage(input.accountId, input.folder, input.uid)),
				),
		);

		registerTools(
			["email_get_message_thread"],
			{
				description:
					"Find, get, lookup, or show message summaries in the same header-based conversation as one known message. Requires accountId when needed, exact folder path, and an IMAP UID returned by search or get. Returns thread message summaries ordered oldest first. Do not use to retrieve full message bodies; use email_get_message for each returned IMAP UID.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: z
						.number()
						.int()
						.positive()
						.describe(
							"IMAP UID of any message in the thread, returned by search/get results; not the email Message-ID header.",
						),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(100)
						.describe(
							"Maximum number of thread message summaries to return, from 1 to 100.",
						),
				},
				outputSchema: {
					accountId: z.string(),
					folder: z.string(),
					threadId: z.string(),
					rootMessageId: z.string(),
					total: z.number().int(),
					truncated: z.boolean(),
					messages: z.array(messageSummaryOutput),
				},
				annotations: titled("Get Email Thread", remoteRead),
			},
			(toolName) =>
				async ({ accountId, folder, uid, limit }: any) =>
					observeTool(toolName, async () =>
						text(await mail.getThread(accountId, folder, uid, limit)),
					),
		);

		registerTools(
			["email_update_message_flags"],
			{
				description:
					"Mark, update, set, or clear read/unread and flagged states for one message or a batch in one account and folder. Requires folder and IMAP UID values from email_search_messages, email_search_all_accounts, or email_get_message_thread. Side effect: updates message flags only; does not move, archive, trash, permanently delete, or send messages.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: uidSchema.describe(
						"One IMAP UID or up to 100 IMAP UIDs returned by search/get/thread results; not Message-ID headers.",
					),
					seen: z
						.boolean()
						.optional()
						.describe(
							"True marks messages read/seen; false marks messages unread/unseen.",
						),
					flagged: z
						.boolean()
						.optional()
						.describe("True flags messages; false unflags messages."),
				},
				outputSchema: {
					uid: uidSchema,
					seen: z.boolean().optional(),
					flagged: z.boolean().optional(),
				},
				annotations: titled("Mark Email", remoteUpdate),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => {
					if (input.seen === undefined && input.flagged === undefined)
						throw new Error("Provide seen, flagged, or both");
					return text(
						await mail.mark(input.accountId, input.folder, input.uid, {
							seen: input.seen,
							flagged: input.flagged,
						}),
					);
				}),
		);

		registerTools(
			["email_move_messages"],
			{
				description:
					"Move or file one message or a batch from one folder to another folder in the same account. Requires source folder, IMAP UID values, and exact targetFolder from email_list_folders. Side effect: moves messages out of the source folder. Use email_search_messages first if you do not know the IMAP UID; use email_archive_messages for archive and email_move_messages_to_trash for trash.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: uidSchema.describe(
						"One IMAP UID or up to 100 IMAP UIDs returned by search/get/thread results; not Message-ID headers.",
					),
					targetFolder: z
						.string()
						.describe(
							"Exact destination IMAP folder path returned by email_list_folders.",
						),
				},
				outputSchema: { uid: uidSchema, from: z.string(), to: z.string() },
				annotations: titled("Move Email", remoteMove),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () =>
					text(
						await mail.move(
							input.accountId,
							input.folder,
							input.uid,
							input.targetFolder,
						),
					),
				),
		);

		registerTools(
			["email_archive_messages"],
			{
				description:
					"Archive one message or a batch in one account without manually finding the archive folder. Requires folder and IMAP UID values from search/get/thread results. Side effect: moves messages to the account's IMAP Archive folder, or provider all-mail folder when that is the advertised archive destination. Use email_search_messages or email_list_all_inbox_messages first if you do not know the IMAP UID. Do not use to trash or permanently delete messages.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: uidSchema.describe(
						"One IMAP UID or up to 100 IMAP UIDs returned by search/get/thread results; not Message-ID headers.",
					),
				},
				outputSchema: {
					uid: uidSchema,
					from: z.string(),
					to: z.string(),
					archived: z.boolean(),
				},
				annotations: titled("Archive Email", remoteMove),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () =>
					text(await mail.archive(input.accountId, input.folder, input.uid)),
				),
		);

		registerTools(
			["email_move_messages_to_trash"],
			{
				description:
					"Move, trash, or delete-to-trash one message or a batch in one account. Requires folder and IMAP UID values from search/get/thread results. Side effect: moves messages to the account's IMAP Trash folder; this is normal deletion and not permanent deletion. Use email_delete_messages_permanently only when the user explicitly wants permanent deletion.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: uidSchema.describe(
						"One IMAP UID or up to 100 IMAP UIDs returned by search/get/thread results; not Message-ID headers.",
					),
				},
				outputSchema: {
					uid: uidSchema,
					from: z.string(),
					to: z.string(),
					trashed: z.boolean(),
				},
				annotations: titled("Move Email to Trash", remoteMove),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () =>
					text(await mail.trash(input.accountId, input.folder, input.uid)),
				),
		);

		registerTools(
			["email_delete_messages_permanently"],
			{
				description:
					"Permanently delete, expunge, or remove one message or a batch from one account and folder. Requires folder and IMAP UID values from search/get/thread results. Dangerous side effect: marks messages deleted and expunges them; use email_move_messages_to_trash for normal deletion.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: uidSchema.describe(
						"One IMAP UID or up to 100 IMAP UIDs returned by search/get/thread results; not Message-ID headers.",
					),
				},
				outputSchema: { uid: uidSchema, deleted: z.boolean() },
				annotations: titled("Delete Email", remoteDelete),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () =>
					text(await mail.delete(input.accountId, input.folder, input.uid)),
				),
		);

		registerTools(
			["email_create_message_draft"],
			{
				description:
					"Compose, create, or prepare a new email draft or reply draft without sending it. For a reply, provide replyToMessage with the original folder and IMAP UID; for a new message, provide to, subject, and text or HTML. Side effect: creates a draft in the IMAP Drafts folder and returns draft folder, IMAP UID, and Message-ID. The draft is always saved with both a plain text and an HTML version, and the user's signature is added automatically after the body (before any quoted original) exactly once, so do not write a signature yourself. Do not use to send; use email_send_draft after reviewing or updating the draft.",
				inputSchema: {
					...accountSelector,
					to: recipientSchema
						.optional()
						.describe(
							"Required for a new message; optional recipient override for a reply draft.",
						),
					cc: optionalRecipientSchema
						.optional()
						.describe("Optional Cc recipient or recipients for the draft."),
					bcc: optionalRecipientSchema
						.optional()
						.describe("Optional Bcc recipient or recipients for the draft."),
					replyTo: replyToSchema
						.optional()
						.describe(
							"Optional Reply-To email address to include on the draft for recipient replies.",
						),
					subject: z
						.string()
						.optional()
						.describe(
							"Required for a new message; defaults to Re: original subject for a reply draft.",
						),
					text: z.string().optional().describe("Plain text body for the draft."),
					html: z.string().optional().describe("HTML body for the draft."),
					replyToMessage: z
						.object({
							folder: z
								.string()
								.describe(
									"Exact IMAP folder path returned by email_list_folders that contains the original message.",
								),
							uid: z
								.number()
								.int()
								.positive()
								.describe(
									"IMAP UID of the original message returned by search/get/thread results; not the Message-ID header.",
								),
							replyAll: z
								.boolean()
								.default(false)
								.describe(
									"True includes original To and Cc recipients where appropriate.",
								),
							quoteOriginal: z
								.boolean()
								.default(true)
								.describe(
									"True quotes original message content in the reply draft; defaults to true unless the user explicitly asks not to quote it.",
								),
						})
						.describe(
							"Original message reference used to create a reply draft; requires folder and IMAP UID.",
						)
						.optional(),
					attachments: z
						.array(attachmentSchema)
						.max(20)
						.optional()
						.describe(
							"Up to 20 attachments; contentBase64 must be raw attachment bytes encoded as base64, not message text or HTML.",
						),
				},
				outputSchema: draftLocationOutput,
				annotations: titled("Create Email Draft", remoteCreate),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => {
					if (!input.text && !input.html)
						throw new Error("Provide text or html message content");
					if (!input.replyToMessage && !input.to)
						throw new Error(
							"Provide to for a new message or replyToMessage for a reply",
						);
					if (!input.replyToMessage && input.subject === undefined)
						throw new Error("Provide subject for a new message");
					return text(await mail.createDraft(input));
				}),
		);

		registerTools(
			["email_create_forward_draft"],
			{
				description:
					"Create, compose, or prepare a forward draft from one existing message without sending it. Requires source folder and IMAP UID returned by search/get/thread results plus destination recipients. Side effect: creates a new draft in the IMAP Drafts folder, optionally copying original attachments. The user's signature is added automatically after your intro text (before the forwarded message) exactly once, so do not write a signature yourself. Do not use to send; use email_send_draft after draft creation.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.default("INBOX")
						.describe(
							"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
						),
					uid: z
						.number()
						.int()
						.positive()
						.describe(
							"IMAP UID returned by search/get/thread results; not the email Message-ID header.",
						),
					to: recipientSchema.describe("Recipient or recipients for the forward draft."),
					cc: optionalRecipientSchema
						.optional()
						.describe("Optional Cc recipient or recipients for the forward draft."),
					bcc: optionalRecipientSchema
						.optional()
						.describe("Optional Bcc recipient or recipients for the forward draft."),
					replyTo: replyToSchema
						.optional()
						.describe(
							"Optional Reply-To email address to include on the forward draft for recipient replies.",
						),
					subject: z
						.string()
						.optional()
						.describe("Optional subject override for the forward draft."),
					text: z
						.string()
						.optional()
						.describe("Optional plain text intro written above the forwarded message."),
					html: z
						.string()
						.optional()
						.describe("Optional HTML intro written above the forwarded message."),
					includeAttachments: z
						.boolean()
						.default(true)
						.describe(
							"True copies original attachments into the forward draft; defaults to true.",
						),
				},
				outputSchema: draftLocationOutput,
				annotations: titled("Create Forward Draft", remoteCreate),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.createForwardDraft(input))),
		);

		registerTools(
			["email_update_message_draft"],
			{
				description:
					"Edit, update, or replace an existing IMAP draft without sending it. Requires draft folder and draft IMAP UID returned by email_create_message_draft, email_create_forward_draft, email_update_message_draft, or search results for drafts. Side effect: replaces the draft and returns a new draft folder and IMAP UID. The user's signature is added automatically to a text or html you supply unless it already contains it; parts you do not supply are kept unchanged. Do not use for non-draft messages or to send; use email_send_draft to send.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.describe("Exact IMAP Drafts folder path containing the draft."),
					uid: z
						.number()
						.int()
						.positive()
						.describe("IMAP UID of the existing draft; not the Message-ID header."),
					to: recipientSchema
						.optional()
						.describe("Optional replacement To recipients for the draft."),
					cc: optionalRecipientSchema
						.optional()
						.describe("Optional replacement Cc recipients for the draft."),
					bcc: optionalRecipientSchema
						.optional()
						.describe("Optional replacement Bcc recipients for the draft."),
					replyTo: replyToSchema
						.optional()
						.describe(
							"Optional replacement Reply-To email address for recipient replies.",
						),
					subject: z
						.string()
						.optional()
						.describe("Optional replacement subject for the draft."),
					text: z
						.string()
						.optional()
						.describe("Optional replacement plain text body for the draft."),
					html: z
						.string()
						.optional()
						.describe("Optional replacement HTML body for the draft."),
					attachments: z
						.array(attachmentSchema)
						.max(20)
						.optional()
						.describe(
							"Omit to preserve existing attachments; pass an empty array to remove all attachments. contentBase64 must be raw attachment bytes encoded as base64, not message text or HTML.",
						),
				},
				outputSchema: {
					...draftLocationOutput,
					replaced: z.object({ folder: z.string(), uid: z.number().int() }),
				},
				annotations: titled("Edit Email Draft", remoteUpdate),
			},
			(toolName) => async (input: any) =>
				observeTool(toolName, async () => text(await mail.editDraft(input))),
		);

		registerTools(
			["email_send_draft"],
			{
				description:
					"Send an existing draft email using SMTP. Requires draft folder and draft IMAP UID returned by email_create_message_draft, email_create_forward_draft, or email_update_message_draft. Side effects: sends the message, appends a copy to the IMAP Sent folder when possible, and deletes the draft after SMTP accepts it. Required to, subject, and text (and cc if the draft has Cc recipients) must be exactly what is in the draft, so the full email is shown in the approval dialog; the server fetches the draft and refuses to send, returning an error listing each mismatch, if to, cc, subject, or text differ (whitespace and line breaks are normalized, address case is ignored). Do not use to compose or edit a draft; use email_update_message_draft to change it first.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.describe("Exact IMAP Drafts folder path returned by a draft tool."),
					uid: z
						.number()
						.int()
						.positive()
						.describe(
							"Draft IMAP UID returned by a draft tool; not the Message-ID header.",
						),
					to: recipientSchema.describe(
						"To recipient email address(es), exactly as in the draft. Verified against the draft before sending.",
					),
					cc: optionalRecipientSchema
						.optional()
						.describe(
							"Cc recipient email address(es), exactly as in the draft; omit only if the draft has no Cc. Verified against the draft before sending.",
						),
					subject: z
						.string()
						.describe(
							"Subject line, exactly as in the draft. Verified against the draft before sending.",
						),
					text: z
						.string()
						.describe(
							"Plain text body, exactly as in the draft. Verified against the draft before sending (whitespace and line breaks normalized).",
						),
				},
				outputSchema: {
					messageId: z.string().optional(),
					accepted: z.array(z.string()),
					rejected: z.array(z.string()),
					accountId: z.string(),
					folder: z.string(),
					uid: z.number().int(),
					sentSaved: z.boolean(),
					sentFolder: z.string().optional(),
					sentUid: z.number().int().optional(),
					sentError: z.string().optional(),
					draftDeleted: z.boolean(),
				},
				annotations: titled("Send Email Draft", remoteSend),
			},
			(toolName) =>
				async ({ accountId, folder, uid, to, cc, subject, text: body }: any) =>
					observeTool(toolName, async () =>
						text(
							await mail.sendDraft(accountId, folder, uid, {
								to,
								cc,
								subject,
								text: body,
							}),
						),
					),
		);

		// --- MCP Apps send approval: preview card + app-only Send/Cancel tools ---
		// Approvals live in KV (shared by all MCP sessions), see src/send-approval.ts.
		const cardMeta = {
			ui: { resourceUri: SEND_PREVIEW_URI },
			"ui/resourceUri": SEND_PREVIEW_URI,
		};
		const appOnlyMeta = { ui: { visibility: ["app"] } };
		const sendResultOutput = {
			messageId: z.string().optional(),
			accepted: z.array(z.string()),
			rejected: z.array(z.string()),
			accountId: z.string(),
			folder: z.string(),
			uid: z.number().int(),
			sentSaved: z.boolean(),
			sentFolder: z.string().optional(),
			sentUid: z.number().int().optional(),
			sentError: z.string().optional(),
			draftDeleted: z.boolean(),
		};
		const consumePreview = (token: string) => consumeApproval(env.EMAIL_KV, token);

		this.server.registerResource(
			"email_send_preview_card",
			SEND_PREVIEW_URI,
			{
				title: "Email send approval card",
				description:
					"Interactive card that shows the full draft email with Send and Cancel buttons.",
				mimeType: MCP_APP_MIME_TYPE,
			},
			async () => ({
				contents: [
					{
						uri: SEND_PREVIEW_URI,
						mimeType: MCP_APP_MIME_TYPE,
						text: SEND_PREVIEW_HTML,
						_meta: { ui: { prefersBorder: true } },
					},
				],
			}),
		);

		this.server.registerTool(
			"email_preview_send",
			{
				description:
					"Show an approval card for sending an existing draft: displays From, To, Cc, Subject, the full plain text body, and the HTML body in a sandbox, with Send and Cancel buttons the user presses themselves. Requires draft folder and draft IMAP UID returned by email_create_message_draft, email_create_forward_draft, or email_update_message_draft. Side effects: none on the mailbox; it only creates a short-lived one-time approval token (15 minutes) bound to a hash of the draft content. Nothing is sent until the user presses Send on the card; if the draft changes afterwards, sending is refused. Prefer this over email_send_draft when the user wants to review the whole email. Do not call any send tool yourself after this; tell the user to review the card.",
				inputSchema: {
					...accountSelector,
					folder: z
						.string()
						.describe("Exact IMAP Drafts folder path returned by a draft tool."),
					uid: z
						.number()
						.int()
						.positive()
						.describe(
							"Draft IMAP UID returned by a draft tool; not the Message-ID header.",
						),
				},
				outputSchema: {
					accountId: z.string(),
					accountName: z.string(),
					canSend: z.boolean(),
					folder: z.string(),
					uid: z.number().int(),
					messageId: z.string().optional(),
					from: z.string(),
					to: z.array(z.string()),
					cc: z.array(z.string()),
					bcc: z.array(z.string()),
					subject: z.string(),
					text: z.string(),
					hasHtml: z.boolean(),
					attachments: z.array(
						z.object({
							filename: z.string().optional(),
							contentType: z.string(),
							size: z.number(),
						}),
					),
					expiresAt: z.string(),
					sent: z.literal(false),
				},
				annotations: titled("Preview Email Before Sending", remoteRead),
				_meta: cardMeta,
			},
			async ({ accountId, folder, uid }: any) =>
				observeTool("email_preview_send", async () => {
					const { html, contentHash, ...shown } = await mail.previewDraft(
						accountId,
						folder,
						uid,
					);
					const token = randomToken();
					const { expiresAt } = await putApproval(env.EMAIL_KV, token, {
						accountId: shown.accountId,
						folder,
						uid,
						contentHash,
					});
					const structured = {
						...shown,
						hasHtml: html !== undefined,
						expiresAt: new Date(expiresAt).toISOString(),
						sent: false as const,
					};
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										...structured,
										note: "NOT sent. An approval card is shown; the user must press Send on it.",
									},
									null,
									2,
								),
							},
						],
						structuredContent: structured,
						// _meta is delivered to the card only; the token and HTML are kept out of content.
						_meta: { previewToken: token, html },
					};
				}),
		);

		this.server.registerResource(
			"email_attachment_preview_card",
			ATTACHMENT_PREVIEW_URI,
			{
				title: "Email attachment card",
				description:
					"Interactive card that shows one email attachment (image preview when possible) with a download button.",
				mimeType: MCP_APP_MIME_TYPE,
			},
			async () => ({
				contents: [
					{
						uri: ATTACHMENT_PREVIEW_URI,
						mimeType: MCP_APP_MIME_TYPE,
						text: ATTACHMENT_PREVIEW_HTML,
						_meta: { ui: { prefersBorder: true } },
					},
				],
			}),
		);

		const attachmentInput = {
			...accountSelector,
			folder: z
				.string()
				.default("INBOX")
				.describe(
					"Exact IMAP folder path returned by email_list_folders; defaults to INBOX.",
				),
			uid: z
				.number()
				.int()
				.positive()
				.describe(
					"IMAP UID returned by search/get/thread results; not the email Message-ID header.",
				),
			attachmentIndex: z
				.number()
				.int()
				.nonnegative()
				.describe("Zero-based attachmentIndex returned by email_get_message."),
		};

		this.server.registerTool(
			"email_preview_attachment",
			{
				description:
					"Show the user a card with one email attachment: file name, type, size, an image preview (png, jpeg, gif, webp; large images are scaled down to at most 1024 px) and a Download button with a signed link that expires after 15 minutes. Requires accountId when needed, exact folder path, IMAP UID, and attachmentIndex returned by email_get_message. The card fetches the attachment itself, so this tool answers immediately and does not check that the attachment exists; the user sees the card and Claude does not receive the file contents or the download link. Side effects: none on the mailbox. Non-image attachments get a card with file name and Download button only. Use email_get_message_attachment instead when you need to hand the user a plain download link. Do not use to read message text or to search for messages.",
				inputSchema: attachmentInput,
				outputSchema: {
					accountId: z.string().optional(),
					folder: z.string(),
					uid: z.number().int(),
					attachmentIndex: z.number().int(),
					cardToken: z
						.string()
						.describe("Signed 15-minute token the card uses to fetch the attachment."),
					expiresAt: z.string(),
				},
				annotations: titled("Preview Email Attachment", remoteRead),
				_meta: {
					ui: { resourceUri: ATTACHMENT_PREVIEW_URI },
					"ui/resourceUri": ATTACHMENT_PREVIEW_URI,
				},
			},
			async ({ accountId, folder, uid, attachmentIndex }: any) =>
				observeTool("email_preview_attachment", async () => {
					const { token, expiresAt } = await createAttachmentToken(env, {
						accountId,
						folder,
						uid,
						attachmentIndex,
					});
					const structured = {
						accountId,
						folder,
						uid,
						attachmentIndex,
						cardToken: token,
						expiresAt,
					};
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										folder,
										uid,
										attachmentIndex,
										expiresAt,
										note: "A card with the attachment is shown to the user. The card fetches the file itself; the file contents and download link are not included here.",
									},
									null,
									2,
								),
							},
						],
						structuredContent: structured,
					};
				}),
		);

		this.server.registerTool(
			"email_get_attachment_preview",
			{
				description:
					"App-only: called by the email_preview_attachment card, never by the model. Fetches the attachment named by the signed card token and returns its file name, type, size, a signed download link, and for png, jpeg, gif and webp an image preview scaled to at most 1024 px as base64. Side effects: none; fails if the token is invalid or expired or the attachment does not exist.",
				inputSchema: {
					cardToken: z
						.string()
						.min(20)
						.describe(
							"Signed token delivered to the card by email_preview_attachment.",
						),
				},
				outputSchema: {
					filename: z.string().optional(),
					contentType: z.string(),
					size: z.number().int(),
					downloadUrl: z.string(),
					expiresAt: z.string(),
					imageResized: z.boolean(),
					image: z.object({ mimeType: z.string(), base64: z.string() }).optional(),
				},
				annotations: titled("Fetch Attachment Preview For Card", remoteRead),
				_meta: appOnlyMeta,
			},
			async ({ cardToken }: any) =>
				observeTool("email_get_attachment_preview", async () => {
					const ref = await openAttachmentLink(env, cardToken);
					if (!ref)
						throw new Error(
							"The card token is invalid or expired; ask for a new preview.",
						);
					const file = await mail.getAttachmentFile(
						ref.accountId,
						ref.folder,
						ref.uid,
						ref.attachmentIndex,
					);
					const link = await createAttachmentLink(env, ref);
					const image = await previewImage(env.IMAGES, file.contentType, file.content);
					const structured = {
						filename: file.filename,
						contentType: file.contentType,
						size: file.content.byteLength,
						downloadUrl: link.downloadUrl,
						expiresAt: link.expiresAt,
						imageResized: image?.resized ?? false,
						image: image && { mimeType: image.mimeType, base64: image.base64 },
					};
					return {
						// The image and link are only in structuredContent, which goes to the card.
						content: [
							{
								type: "text" as const,
								text: "Attachment preview delivered to the card.",
							},
						],
						structuredContent: structured,
					};
				}),
		);

		this.server.registerTool(
			"email_send_previewed_draft",
			{
				description:
					"App-only: called by the Send button on the email_preview_send card, never by the model. Sends the previewed draft using SMTP with a one-time approval token. Side effects: sends the message, appends a copy to the IMAP Sent folder when possible, and deletes the draft; refuses and sends nothing if the token is invalid, used, or expired, or the draft content changed since the preview.",
				inputSchema: {
					previewToken: z
						.string()
						.min(20)
						.describe(
							"One-time approval token delivered to the card by email_preview_send.",
						),
				},
				outputSchema: sendResultOutput,
				annotations: titled("Send Previewed Email Draft", remoteSend),
				_meta: appOnlyMeta,
			},
			async ({ previewToken }: any) =>
				observeTool("email_send_previewed_draft", async () => {
					const record = await consumePreview(previewToken);
					return text(
						await mail.sendApprovedDraft(
							record.accountId,
							record.folder,
							record.uid,
							record.contentHash,
						),
					);
				}),
		);

		this.server.registerTool(
			"email_cancel_previewed_draft",
			{
				description:
					"App-only: called by the Cancel button on the email_preview_send card, never by the model. Invalidates the one-time approval token so the previewed draft can no longer be sent from that card. Does not delete the draft or change the mailbox.",
				inputSchema: {
					previewToken: z
						.string()
						.min(20)
						.describe(
							"One-time approval token delivered to the card by email_preview_send.",
						),
				},
				outputSchema: { cancelled: z.boolean() },
				annotations: titled(
					"Cancel Previewed Email Send",
					annotations(false, false, true, false),
				),
				_meta: appOnlyMeta,
			},
			async ({ previewToken }: any) =>
				observeTool("email_cancel_previewed_draft", async () => {
					await cancelApproval(env.EMAIL_KV, previewToken);
					return text({ cancelled: true });
				}),
		);
	}
}

function annotations(
	readOnlyHint: boolean,
	destructiveHint: boolean,
	idempotentHint: boolean,
	openWorldHint: boolean,
): ToolAnnotations {
	return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

function titled(title: string, hints: ToolAnnotations): ToolAnnotations {
	return { ...hints, title };
}

function text(value: unknown, structuredContent?: Record<string, unknown>) {
	const structured =
		structuredContent ??
		(typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: { result: value });
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		structuredContent: structured,
	};
}

import { handleRequest } from "./auth";

const mcpHandler = MyMCP.serve(withBasePath("/mcp"));

/**
 * Logs the JSON-RPC method of every MCP request (plus the resource URI for resources/read and
 * the tool name for tools/call) so client behavior can be traced with `wrangler tail`.
 * Parameters and arguments are never logged.
 */
async function logRpcRequest(request: Request): Promise<void> {
	try {
		const base = {
			event: "mcp_rpc",
			httpMethod: request.method,
			sessionId: request.headers.get("mcp-session-id")?.slice(0, 8),
		};
		if (request.method !== "POST") {
			console.log(base);
			return;
		}
		const body = JSON.parse(await request.clone().text());
		for (const message of Array.isArray(body) ? body : [body]) {
			const params = message?.params;
			console.log({
				...base,
				rpcMethod: message?.method ?? (message?.result ? "(response)" : "(unknown)"),
				id: message?.id,
				uri: message?.method === "resources/read" ? params?.uri : undefined,
				tool: message?.method === "tools/call" ? params?.name : undefined,
			});
		}
	} catch {
		console.log({ event: "mcp_rpc", httpMethod: request.method, rpcMethod: "(unparseable)" });
	}
}

/**
 * GET /myMail/download/<token>: the signed token is the credential. Anything wrong with it, or
 * with the message or attachment it points at, answers 404. Nothing here logs the URL.
 */
async function downloadAttachment(
	request: Request,
	env: MailEnv,
	pathname: string,
): Promise<Response> {
	const notFound = () =>
		new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
	if (request.method !== "GET") return notFound();
	const ref = await openAttachmentLink(env, pathname.slice(DOWNLOAD_PREFIX.length));
	if (!ref) return notFound();
	try {
		const mail = new MailService(
			new AccountStore(env.EMAIL_KV, env.CREDENTIAL_ENCRYPTION_KEY),
			{
				clientId: env.OUTLOOK_CLIENT_ID,
				clientSecret: env.OUTLOOK_CLIENT_SECRET,
			},
		);
		const file = await mail.getAttachmentFile(
			ref.accountId,
			ref.folder,
			ref.uid,
			ref.attachmentIndex,
		);
		return new Response(file.content, {
			headers: {
				"Content-Type": file.contentType || "application/octet-stream",
				"Content-Length": String(file.content.byteLength),
				"Content-Disposition": attachmentDisposition(file.filename),
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		console.error({
			event: "attachment_download",
			status: "error",
			error: safeErrorCategory(error),
		});
		return notFound();
	}
}

export default {
	async fetch(request: Request, env: MailEnv, ctx: ExecutionContext): Promise<Response> {
		const downloadPath = new URL(request.url).pathname;
		if (downloadPath.startsWith(DOWNLOAD_PREFIX))
			return downloadAttachment(request, env, downloadPath);
		return handleRequest(request, env, {
			mcp: () => {
				ctx.waitUntil(logRpcRequest(request));
				return mcpHandler.fetch(request, env, ctx);
			},
			app: () => app.fetch(request, env, ctx),
		});
	},
} satisfies ExportedHandler<MailEnv>;

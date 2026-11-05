import { gmail as gmailClient, type gmail_v1 } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { convert } from "html-to-text";
import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";
import { gmailSpec } from "./gmail-spec.js";
import type { GoogleTool } from "./tools.js";

/**
 * Gmail tools with the names, inputs and output shape of Google's Gmail MCP server
 * (see gmail-spec.ts), implemented on the formal Gmail API. Where the reference does
 * not specify behavior, the choices below are this server's and are stated to the model.
 */
type Gmail = gmail_v1.Gmail;
type Options = { signal: AbortSignal; retry: false; timeout: number; maxRedirects: number };
type Format = "MINIMAL" | "FULL_CONTENT" | "METADATA_ONLY";

// Bodies are often far larger than what an agent needs (marketing HTML, quoted history).
export const bodyLimit = 30_000, threadBodyBudget = 120_000;
const fanOut = 8;
const visibleSystemLabels = new Set(["INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT"]);
const headerNames = ["Subject", "From", "To", "Cc", "Bcc", "Date"];

const note = {
  body: "This server: bodies are decoded. plaintextBody is the text/plain part, or text converted from the HTML part when the message has no usable plain text. " +
    `plaintextBody and htmlBody are each limited to ${bodyLimit.toLocaleString("en-US")} characters; a shortened body ends with "…[truncated: N more characters]". ` +
    "date is an ISO 8601 timestamp.",
  thread: `If a thread's bodies exceed ${threadBodyBudget.toLocaleString("en-US")} characters in total, the oldest messages keep their metadata and snippet only; read those with get_message.`,
};

const describe = <T extends z.ZodType>(schema: T, text: string) => schema.describe(text);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const plainAddress = z.email().max(254);

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string) {
  return headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}
function addresses(value: string) {
  return value ? addressparser(value, { flatten: true }).map((entry) => entry.address).filter(Boolean) : [];
}
function isoDate(message: gmail_v1.Schema$Message, headers: gmail_v1.Schema$MessagePartHeader[] | undefined) {
  const millis = Number(message.internalDate ?? Date.parse(header(headers, "Date")));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : "";
}
function shorten(text: string, limit = bodyLimit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated: ${text.length - limit} more characters]`;
}
function decode(data: string | null | undefined) {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}
function walk(part: gmail_v1.Schema$MessagePart | undefined, visit: (part: gmail_v1.Schema$MessagePart) => void) {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}
/** A text/plain part that only points to the HTML version ("View this email in your browser"). */
function placeholder(text: string, html: string) {
  return !!html && text.replace(/\s+/g, " ").trim().length < 200 && html.length > 5 * text.length;
}

export interface GmailMessage {
  id: string; snippet?: string; subject?: string; sender: string; toRecipients: string[]; ccRecipients: string[]; date: string;
  plaintextBody?: string; attachmentIds?: string[]; htmlBody?: string;
  attachments?: Array<{ id: string; mimeType: string; filename: string }>; labelIds: string[];
}

async function bodies(api: Gmail, message: gmail_v1.Schema$Message, o: Options) {
  let text = "", html = "";
  const attachments: Array<{ id: string; mimeType: string; filename: string }> = [];
  const pending: Array<Promise<void>> = [];
  walk(message.payload, (part) => {
    const mimeType = part.mimeType ?? "";
    if (part.filename) {
      if (part.body?.attachmentId) attachments.push({ id: part.body.attachmentId, mimeType, filename: part.filename });
      return;
    }
    if (mimeType !== "text/plain" && mimeType !== "text/html") return;
    const assign = (value: string) => {
      if (mimeType === "text/plain" && !text) text = value;
      if (mimeType === "text/html" && !html) html = value;
    };
    if (part.body?.data) assign(decode(part.body.data));
    // Large text parts are stored as attachments and must be fetched separately.
    else if (part.body?.attachmentId && message.id) pending.push(api.users.messages.attachments.get(
      { userId: "me", messageId: message.id, id: part.body.attachmentId }, o).then((response) => assign(decode(response.data.data))));
  });
  await Promise.all(pending);
  if (html && (!text.trim() || placeholder(text, html)))
    text = convert(html, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }, { selector: "a", options: { hideLinkHrefIfSameAsText: true } }] });
  return { text: text.trim(), html, attachments };
}

async function shape(api: Gmail, message: gmail_v1.Schema$Message, format: Format, o: Options): Promise<GmailMessage> {
  const headers = message.payload?.headers ?? undefined;
  const base: GmailMessage = {
    id: message.id ?? "", sender: addresses(header(headers, "From"))[0] ?? "", toRecipients: addresses(header(headers, "To")),
    ccRecipients: addresses(header(headers, "Cc")), date: isoDate(message, headers),
    labelIds: (message.labelIds ?? []).filter((label) => label.startsWith("Label_") || visibleSystemLabels.has(label)),
  };
  if (format === "METADATA_ONLY") return base;
  const minimal = { ...base, snippet: message.snippet ?? "", subject: header(headers, "Subject") };
  if (format === "MINIMAL") return minimal;
  const content = await bodies(api, message, o);
  return { ...minimal, plaintextBody: shorten(content.text), htmlBody: shorten(content.html),
    attachmentIds: content.attachments.map((entry) => entry.id), attachments: content.attachments };
}
const apiFormat = (format: Format) => format === "FULL_CONTENT" ? "full" : "metadata";

/** Newest messages keep their bodies; older ones fall back to metadata and snippet past the budget. */
export function budgetThread(messages: GmailMessage[], budget = threadBodyBudget) {
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const size = (message.plaintextBody?.length ?? 0) + (message.htmlBody?.length ?? 0);
    if (used + size <= budget) { used += size; continue; }
    message.plaintextBody = `…[body omitted: thread too long; read it with get_message ${message.id}]`;
    message.htmlBody = "";
  }
  return messages;
}

async function mapLimited<T, R>(items: T[], work: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(fanOut, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}

const messageFormat = z.enum(["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY"]).default("FULL_CONTENT");
const normalize = (format: z.infer<typeof messageFormat>): Format => format === "MESSAGE_FORMAT_UNSPECIFIED" ? "FULL_CONTENT" : format;
// The reference routes adding trash/spam through dedicated sensitive tools, which are not offered here.
const labelEdit = (target: "threadId" | "messageId", spec: { fields: Record<string, string> }, add: boolean) => z.object({
  [target]: describe(id, spec.fields[target]!),
  labelIds: describe(z.array(id).min(1).max(100).refine((labels) => !add || !labels.some((label) => label === "TRASH" || label === "SPAM"),
    "sensitive_label_not_supported"), spec.fields.labelIds!),
}).strict();

function gmailTool<Input>(name: keyof typeof gmailSpec, risk: GoogleTool["risk"], input: z.ZodType<Input>,
  run: (api: Gmail, input: Input, o: Options) => Promise<unknown>, extra = ""): GoogleTool<Input> {
  return { name, risk, input, description: gmailSpec[name].description + (extra ? `\n\n${extra}` : ""),
    execute: (auth: OAuth2Client, value: Input, signal: AbortSignal) =>
      run(gmailClient({ version: "v1", auth }), value, { signal, retry: false, timeout: 30_000, maxRedirects: 0 }) };
}

async function setLabels(add: boolean, kind: "threads" | "messages", target: string, labelIds: string[], api: Gmail, o: Options) {
  const requestBody = add ? { addLabelIds: labelIds } : { removeLabelIds: labelIds };
  if (kind === "threads") await api.users.threads.modify({ userId: "me", id: target, requestBody }, o);
  else await api.users.messages.modify({ userId: "me", id: target, requestBody }, o);
  return {};
}

export function gmailTools(): GoogleTool[] {
  const s = gmailSpec;
  return [
    gmailTool("search_threads", "read", z.object({
      pageSize: describe(z.number().int().min(1).max(50).default(20), s.search_threads.fields.pageSize),
      pageToken: describe(z.string().max(4096).optional(), s.search_threads.fields.pageToken),
      query: describe(z.string().max(4000).optional(), s.search_threads.fields.query),
      includeTrash: describe(z.boolean().default(false), s.search_threads.fields.includeTrash),
      view: describe(z.enum(["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY"]).default("THREAD_VIEW_MINIMAL"), s.search_threads.fields.view),
    }).strict(), async (api, p, o) => {
      const query = p.query?.trim() ?? "";
      // Drafts are excluded by default; spam stays excluded even when trash is included.
      const q = [query, /\bin:(draft|anywhere)\b/i.test(query) ? "" : "-in:draft", p.includeTrash && !/\bin:(spam|anywhere)\b/i.test(query) ? "-in:spam" : ""]
        .filter(Boolean).join(" ");
      const list = await api.users.threads.list({ userId: "me", q, maxResults: p.pageSize, pageToken: p.pageToken, includeSpamTrash: p.includeTrash }, o);
      const format: Format = p.view === "THREAD_VIEW_METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";
      const threads = await mapLimited(list.data.threads ?? [], async (thread) => {
        const full = await api.users.threads.get({ userId: "me", id: thread.id!, format: "metadata", metadataHeaders: headerNames }, o);
        return { id: thread.id ?? "", messages: await Promise.all((full.data.messages ?? []).map((message) => shape(api, message, format, o))) };
      });
      return { threads, nextPageToken: list.data.nextPageToken ?? "", resultCountEstimate: String(list.data.resultSizeEstimate ?? threads.length) };
    }),
    gmailTool("get_thread", "read", z.object({
      threadId: describe(id, s.get_thread.fields.threadId), messageFormat: describe(messageFormat, s.get_thread.fields.messageFormat),
    }).strict(), async (api, p, o) => {
      const format = normalize(p.messageFormat);
      const thread = await api.users.threads.get({ userId: "me", id: p.threadId, format: apiFormat(format),
        ...(format === "FULL_CONTENT" ? {} : { metadataHeaders: headerNames }) }, o);
      const messages = await mapLimited(thread.data.messages ?? [], (message) => shape(api, message, format, o));
      return { id: thread.data.id ?? p.threadId, messages: budgetThread(messages) };
    }, `${note.body} ${note.thread}`),
    gmailTool("get_message", "read", z.object({
      messageId: describe(id, s.get_message.fields.messageId), messageFormat: describe(messageFormat, s.get_message.fields.messageFormat),
    }).strict(), async (api, p, o) => {
      const format = normalize(p.messageFormat);
      const message = await api.users.messages.get({ userId: "me", id: p.messageId, format: apiFormat(format),
        ...(format === "FULL_CONTENT" ? {} : { metadataHeaders: headerNames }) }, o);
      return shape(api, message.data, format, o);
    }, note.body),
    gmailTool("list_labels", "read", z.object({
      pageSize: describe(z.number().int().min(1).max(200).default(100), s.list_labels.fields.pageSize),
      pageToken: describe(z.string().regex(/^\d{1,6}$/).optional(), s.list_labels.fields.pageToken),
    }).strict(), async (api, p, o) => {
      // The Gmail API returns every label at once; pages are served locally by offset.
      const all = ((await api.users.labels.list({ userId: "me" }, o)).data.labels ?? []).filter((label) => label.type === "user")
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      const start = Number(p.pageToken ?? 0), slice = all.slice(start, start + p.pageSize);
      const labels = await mapLimited(slice, async (label) => {
        const detail = (await api.users.labels.get({ userId: "me", id: label.id! }, o)).data;
        return { labelId: detail.id ?? "", name: detail.name ?? "",
          ...(detail.color ? { color: { textColor: detail.color.textColor ?? "", backgroundColor: detail.color.backgroundColor ?? "" } } : {}),
          threadsTotal: detail.threadsTotal ?? 0, threadsUnread: detail.threadsUnread ?? 0 };
      });
      return { labels, nextPageToken: start + p.pageSize < all.length ? String(start + p.pageSize) : "" };
    }),
    gmailTool("list_drafts", "read", z.object({
      pageSize: describe(z.number().int().min(1).max(50).default(20), s.list_drafts.fields.pageSize),
      pageToken: describe(z.string().max(4096).optional(), s.list_drafts.fields.pageToken),
      query: describe(z.string().max(4000).optional(), s.list_drafts.fields.query),
      view: describe(z.enum(["DRAFT_VIEW_UNSPECIFIED", "DRAFT_VIEW_METADATA_ONLY", "DRAFT_VIEW_FULL"]).default("DRAFT_VIEW_FULL"), s.list_drafts.fields.view),
    }).strict(), async (api, p, o) => {
      const list = await api.users.drafts.list({ userId: "me", maxResults: p.pageSize, pageToken: p.pageToken, q: p.query }, o);
      const metadataOnly = p.view === "DRAFT_VIEW_METADATA_ONLY";
      const drafts = await mapLimited(list.data.drafts ?? [], async (draft) => {
        const data = (await api.users.drafts.get({ userId: "me", id: draft.id!, format: metadataOnly ? "metadata" : "full" }, o)).data;
        const message = data.message ?? {}, headers = message.payload?.headers ?? undefined;
        const common = { id: data.id ?? "", threadId: message.threadId ?? "", toRecipients: addresses(header(headers, "To")),
          ccRecipients: addresses(header(headers, "Cc")), bccRecipients: addresses(header(headers, "Bcc")), date: isoDate(message, headers) };
        if (metadataOnly) return common;
        const content = await bodies(api, message, o);
        return { ...common, subject: header(headers, "Subject"), plaintextBody: shorten(content.text), htmlBody: shorten(content.html) };
      });
      return { drafts, nextPageToken: list.data.nextPageToken ?? "" };
    }, note.body),
    gmailTool("create_draft", "write", z.object({
      to: describe(z.array(plainAddress).max(100).default([]), s.create_draft.fields.to),
      cc: describe(z.array(plainAddress).max(100).default([]), s.create_draft.fields.cc),
      bcc: describe(z.array(plainAddress).max(100).default([]), s.create_draft.fields.bcc),
      subject: describe(z.string().max(1000).regex(/^[^\r\n]*$/).default(""), s.create_draft.fields.subject),
      body: describe(z.string().max(200_000).optional(), s.create_draft.fields.body),
      htmlBody: describe(z.string().max(500_000).optional(), s.create_draft.fields.htmlBody),
      replyToMessageId: describe(id.optional(), s.create_draft.fields.replyToMessageId),
      // Accepted for schema parity; the reference states attachments are not supported yet.
      attachments: describe(z.array(z.unknown()).max(0, "attachments_not_supported").optional(), s.create_draft.fields.attachments),
    }).strict(), async (api, p, o) => {
      let threadId: string | undefined, reply: { inReplyTo?: string; references?: string } = {}, text = p.body ?? "", html = p.htmlBody;
      if (p.replyToMessageId) {
        const original = (await api.users.messages.get({ userId: "me", id: p.replyToMessageId, format: "full" }, o)).data;
        const headers = original.payload?.headers ?? undefined, messageId = header(headers, "Message-ID");
        threadId = original.threadId ?? undefined;
        reply = { inReplyTo: messageId, references: [header(headers, "References"), messageId].filter(Boolean).join(" ") };
        // The reply text is followed by the original message, as the reference describes.
        const content = await bodies(api, original, o), from = header(headers, "From"), when = header(headers, "Date");
        text = `${text}\n\nOn ${when}, ${from} wrote:\n${content.text.split("\n").map((line) => `> ${line}`).join("\n")}`;
        if (html !== undefined) html = `${html}<br><br><div>On ${when}, ${from} wrote:</div><blockquote>${content.html || content.text}</blockquote>`;
      }
      const mime = new MailComposer({ to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, text, ...(html !== undefined ? { html } : {}),
        ...reply, textEncoding: "base64" }).compile();
      mime.keepBcc = true; // A draft keeps its Bcc recipients; Gmail strips the header when sending.
      const raw = await mime.build();
      const draft = await api.users.drafts.create({ userId: "me", requestBody: { message: { raw: raw.toString("base64url"), ...(threadId ? { threadId } : {}) } } }, o);
      return { id: draft.data.id ?? "" };
    }),
    gmailTool("label_thread", "write", labelEdit("threadId", s.label_thread, true),
      (api, p, o) => setLabels(true, "threads", p.threadId as string, p.labelIds as string[], api, o)),
    gmailTool("unlabel_thread", "write", labelEdit("threadId", s.unlabel_thread, false),
      (api, p, o) => setLabels(false, "threads", p.threadId as string, p.labelIds as string[], api, o)),
    gmailTool("label_message", "write", labelEdit("messageId", s.label_message, true),
      (api, p, o) => setLabels(true, "messages", p.messageId as string, p.labelIds as string[], api, o)),
    gmailTool("unlabel_message", "write", labelEdit("messageId", s.unlabel_message, false),
      (api, p, o) => setLabels(false, "messages", p.messageId as string, p.labelIds as string[], api, o)),
  ];
}

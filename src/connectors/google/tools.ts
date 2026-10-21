import { gmail } from "@googleapis/gmail";
import { drive } from "@googleapis/drive";
import { docs } from "@googleapis/docs";
import { sheets } from "@googleapis/sheets";
import { slides } from "@googleapis/slides";
import { calendar } from "@googleapis/calendar";
import type { OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Risk } from "../../connector.js";
import type { GoogleProduct } from "./account.js";

function clients(auth: OAuth2Client) {
  return { gmail: gmail({ version: "v1", auth }), drive: drive({ version: "v3", auth }),
    docs: docs({ version: "v1", auth }), sheets: sheets({ version: "v4", auth }),
    slides: slides({ version: "v1", auth }), calendar: calendar({ version: "v3", auth }) };
}
type APIs = ReturnType<typeof clients>;
type RequestOptions = { signal: AbortSignal; retry: false; timeout: number; maxRedirects: number };
export interface GoogleTool<Input = any> {
  name: string;
  description: string;
  risk: Risk;
  input: z.ZodType<Input>;
  execute(auth: OAuth2Client, input: Input, signal: AbortSignal): Promise<unknown>;
}
function tool<Input>(name: string, description: string, risk: Risk, input: z.ZodType<Input>,
  run: (apis: APIs, input: Input, options: RequestOptions) => Promise<{ data: unknown }>): GoogleTool<Input> {
  return { name, description, risk, input,
    execute: async (auth, value, signal) => (await run(clients(auth), value, { signal, retry: false, timeout: 30_000, maxRedirects: 0 })).data };
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const page = { pageToken: z.string().max(4096).optional(), maxResults: z.number().int().min(1).max(100).default(25) };
const message = z.object({ messageId: id }).strict();
const file = z.object({ fileId: id }).strict();
const text = z.string().max(200_000);
const address = z.email().max(254);
const empty = z.object({}).strict();
const cells = z.array(z.array(z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()])).max(1000)).max(1000);
const range = z.string().min(1).max(1000);
const calendarId = z.string().regex(/^[A-Za-z0-9_.@#-]{1,512}$/).default("primary");
const eventTime = z.union([
  z.object({ date: z.iso.date() }).strict(),
  z.object({ dateTime: z.iso.datetime({ offset: true }), timeZone: z.string().max(128).optional() }).strict(),
]);
const eventFields = {
  summary: z.string().min(1).max(1000), description: text.optional(), location: z.string().max(2000).optional(),
  start: eventTime, end: eventTime,
  attendees: z.array(z.object({ email: address }).strict()).max(100).optional(),
};

function subjectHeader(subject: string) {
  const words: string[] = [];
  let part = "";
  for (const character of subject) {
    if (Buffer.byteLength(part + character) > 42) { words.push(part); part = ""; }
    part += character;
  }
  words.push(part);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
}

/** All request methods and endpoint families are fixed here; no raw API passthrough. */
export function googleTools(product: GoogleProduct): GoogleTool[] {
  switch (product) {
    case "gmail": return [
      tool("search_threads", "Search the owner's Gmail threads; q uses Gmail search syntax.", "read",
        z.object({ q: z.string().max(4000).optional(), ...page }).strict(),
        (a, p, o) => a.gmail.users.threads.list({ userId: "me", ...p }, o)),
      tool("get_thread", "Read a Gmail thread and its messages.", "read", z.object({ threadId: id }).strict(),
        (a, p, o) => a.gmail.users.threads.get({ userId: "me", id: p.threadId, format: "full" }, o)),
      tool("get_message", "Read a Gmail message.", "read", message,
        (a, p, o) => a.gmail.users.messages.get({ userId: "me", id: p.messageId, format: "full" }, o)),
      tool("list_drafts", "List Gmail drafts.", "read", z.object(page).strict(),
        (a, p, o) => a.gmail.users.drafts.list({ userId: "me", ...p }, o)),
      tool("list_labels", "List Gmail labels.", "read", empty, (a, _p, o) => a.gmail.users.labels.list({ userId: "me" }, o)),
      tool("create_draft", "Create a plain-text Gmail draft. This does not send mail.", "write",
        z.object({ to: z.array(address).min(1).max(100), cc: z.array(address).max(100).optional(),
          subject: z.string().max(1000).regex(/^[^\r\n]*$/), body: text }).strict(),
        (a, p, o) => {
          const mime = [
            `To: ${p.to.join(", ")}`, ...(p.cc?.length ? [`Cc: ${p.cc.join(", ")}`] : []),
            `Subject: ${subjectHeader(p.subject)}`,
            "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
            Buffer.from(p.body).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "",
          ].join("\r\n");
          return a.gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: Buffer.from(mime).toString("base64url") } } }, o);
        }),
      tool("modify_message_labels", "Add or remove labels on one message.", "write",
        z.object({ messageId: id, addLabelIds: z.array(id).max(100).default([]), removeLabelIds: z.array(id).max(100).default([]) }).strict(),
        (a, p, o) => a.gmail.users.messages.modify({ userId: "me", id: p.messageId,
          requestBody: { addLabelIds: p.addLabelIds, removeLabelIds: p.removeLabelIds } }, o)),
    ];
    case "drive": return [
      tool("search_files", "List or search Drive files. q uses Drive query syntax.", "read",
        z.object({ q: z.string().max(4000).optional(), ...page }).strict(),
        (a, p, o) => a.drive.files.list({ q: p.q, pageToken: p.pageToken, pageSize: p.maxResults,
          fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents)" }, o)),
      tool("get_file_metadata", "Get Drive file metadata.", "read", file,
        (a, p, o) => a.drive.files.get({ fileId: p.fileId, fields: "id,name,mimeType,size,modifiedTime,webViewLink,parents,description" }, o)),
      tool("read_file_content", "Download a Drive binary/text file as base64 (up to 10 MB). Use the Docs/Sheets/Slides tools for native Google files.", "read", file,
        async (a, p, o) => {
          const response = await a.drive.files.get({ fileId: p.fileId, alt: "media" }, { ...o, responseType: "arraybuffer", maxContentLength: 10_000_000 });
          return { data: { contentBase64: Buffer.from(response.data as unknown as ArrayBuffer).toString("base64") } };
        }),
      tool("create_file", "Create a UTF-8 text file in Drive.", "write",
        z.object({ name: z.string().min(1).max(255), content: text, parentId: id.optional() }).strict(),
        (a, p, o) => a.drive.files.create({ requestBody: { name: p.name, mimeType: "text/plain", ...(p.parentId ? { parents: [p.parentId] } : {}) },
          media: { mimeType: "text/plain", body: Readable.from([p.content]) }, fields: "id,name,webViewLink" }, o)),
      tool("copy_file", "Copy a Drive file.", "write", z.object({ fileId: id, name: z.string().max(255).optional(), parentId: id.optional() }).strict(),
        (a, p, o) => a.drive.files.copy({ fileId: p.fileId, requestBody: { name: p.name, ...(p.parentId ? { parents: [p.parentId] } : {}) }, fields: "id,name,webViewLink" }, o)),
    ];
    case "docs": return [
      tool("read_doc", "Read a Google document.", "read", z.object({ documentId: id }).strict(),
        (a, p, o) => a.docs.documents.get({ documentId: p.documentId, includeTabsContent: true }, o)),
      tool("create_doc", "Create an empty Google document.", "write", z.object({ title: z.string().min(1).max(255) }).strict(),
        (a, p, o) => a.docs.documents.create({ requestBody: p }, o)),
      tool("append_text", "Append text to a document body, optionally in a specific tab.", "write",
        z.object({ documentId: id, text, tabId: id.optional() }).strict(),
        (a, p, o) => a.docs.documents.batchUpdate({ documentId: p.documentId,
          requestBody: { requests: [{ insertText: { endOfSegmentLocation: { ...(p.tabId ? { tabId: p.tabId } : {}) }, text: p.text } }] } }, o)),
    ];
    case "sheets": return [
      tool("get_spreadsheet", "Read spreadsheet metadata and sheet properties.", "read", z.object({ spreadsheetId: id }).strict(),
        (a, p, o) => a.sheets.spreadsheets.get({ spreadsheetId: p.spreadsheetId, includeGridData: false }, o)),
      tool("get_values", "Read values in an A1 range.", "read", z.object({ spreadsheetId: id, range }).strict(),
        (a, p, o) => a.sheets.spreadsheets.values.get(p, o)),
      tool("update_values", "Replace values in an A1 range. RAW writes literal values; USER_ENTERED also parses formulas.", "write",
        z.object({ spreadsheetId: id, range, values: cells, valueInputOption: z.enum(["RAW", "USER_ENTERED"]).default("RAW") }).strict(),
        (a, p, o) => a.sheets.spreadsheets.values.update({ spreadsheetId: p.spreadsheetId, range: p.range,
          valueInputOption: p.valueInputOption, requestBody: { values: p.values } }, o)),
      tool("append_values", "Append rows to a spreadsheet table.", "write",
        z.object({ spreadsheetId: id, range, values: cells, valueInputOption: z.enum(["RAW", "USER_ENTERED"]).default("RAW") }).strict(),
        (a, p, o) => a.sheets.spreadsheets.values.append({ spreadsheetId: p.spreadsheetId, range: p.range,
          valueInputOption: p.valueInputOption, insertDataOption: "INSERT_ROWS", requestBody: { values: p.values } }, o)),
    ];
    case "slides": return [
      tool("read_presentation", "Read a Google Slides presentation.", "read", z.object({ presentationId: id }).strict(),
        (a, p, o) => a.slides.presentations.get(p, o)),
      tool("create_presentation", "Create an empty Google Slides presentation.", "write", z.object({ title: z.string().min(1).max(255) }).strict(),
        (a, p, o) => a.slides.presentations.create({ requestBody: p }, o)),
      tool("replace_text", "Replace matching text in a presentation or selected pages.", "write",
        z.object({ presentationId: id, find: z.string().min(1).max(10_000), replaceWith: text, matchCase: z.boolean().default(true), pageObjectIds: z.array(id).max(100).optional() }).strict(),
        (a, p, o) => a.slides.presentations.batchUpdate({ presentationId: p.presentationId, requestBody: { requests: [{
          replaceAllText: { containsText: { text: p.find, matchCase: p.matchCase }, replaceText: p.replaceWith, pageObjectIds: p.pageObjectIds },
        }] } }, o)),
    ];
    case "calendar": return [
      tool("list_calendars", "List the owner's calendars.", "read", z.object(page).strict(),
        (a, p, o) => a.calendar.calendarList.list(p, o)),
      tool("list_events", "List events, optionally within a time range.", "read",
        z.object({ calendarId, ...page, timeMin: z.iso.datetime({ offset: true }).optional(), timeMax: z.iso.datetime({ offset: true }).optional(), q: z.string().max(1000).optional() }).strict(),
        (a, p, o) => a.calendar.events.list({ ...p, singleEvents: true, orderBy: "startTime" }, o)),
      tool("get_event", "Read one calendar event.", "read", z.object({ calendarId, eventId: id }).strict(),
        (a, p, o) => a.calendar.events.get(p, o)),
      tool("create_event", "Create a calendar event. Review attendees and sendUpdates before approval.", "write",
        z.object({ calendarId, ...eventFields, sendUpdates: z.enum(["none", "all", "externalOnly"]).default("none") }).strict(),
        (a, p, o) => {
          const { calendarId, sendUpdates, ...requestBody } = p;
          return a.calendar.events.insert({ calendarId, sendUpdates, requestBody }, o);
        }),
      tool("delete_event", "Delete a calendar event; sendUpdates controls attendee notifications.", "write",
        z.object({ calendarId, eventId: id, sendUpdates: z.enum(["none", "all", "externalOnly"]).default("none") }).strict(),
        (a, p, o) => a.calendar.events.delete(p, o)),
    ];
  }
}

import type { OperationCatalog, OperationSpec } from "../../connector.js";
import type { GoogleProduct } from "./account.js";

const scope = (name: string) => name === "mail" ? "https://mail.google.com/" : `https://www.googleapis.com/auth/gmail.${name}`;
const scopes = (...names: string[]) => names.map(scope);

/**
 * Gmail operations the owner can set, grouped like the account's permission page. Scopes are those the Gmail API
 * accepts for the methods behind each operation; grantScope is the narrowest one to add.
 */
const gmailOperations: OperationSpec[] = [
  { id: "gmail.messages.read", group: "read", label: "Search and read messages and threads", labelZh: "搜索和读取邮件", risk: "read",
    scopes: scopes("readonly", "modify", "mail") },
  { id: "gmail.drafts.read", group: "read", label: "Read drafts", labelZh: "读取草稿", risk: "read",
    scopes: scopes("readonly", "compose", "modify", "mail") },
  { id: "gmail.labels.read", group: "read", label: "Read labels, filters and settings", labelZh: "读取标签、过滤器和设置", risk: "read",
    scopes: scopes("readonly", "labels", "settings.basic", "modify", "mail") },
  { id: "gmail.drafts.write", group: "write", label: "Create, edit and delete drafts", labelZh: "创建、编辑和删除草稿", risk: "write",
    scopes: scopes("compose", "modify", "mail"), grantScope: scope("compose") },
  { id: "gmail.send", group: "write", label: "Send email", labelZh: "发送邮件", risk: "write",
    scopes: scopes("send", "compose", "modify", "mail"), grantScope: scope("send") },
  { id: "gmail.unsubscribe", group: "write", label: "Unsubscribe from mailing lists", labelZh: "退订邮件列表", risk: "write", supported: false },
  { id: "gmail.labels.manage", group: "write", label: "Create, rename and delete labels", labelZh: "管理标签", risk: "write",
    scopes: scopes("labels", "modify", "mail"), grantScope: scope("labels") },
  { id: "gmail.messages.modify", group: "write", label: "Mark read or unread, star, archive and apply labels", labelZh: "标记已读/未读、加星、归档和添加标签", risk: "write",
    scopes: scopes("modify", "mail"), grantScope: scope("modify") },
  { id: "gmail.settings.write", group: "write", label: "Change filters and mailbox settings", labelZh: "修改过滤器和邮箱设置", risk: "write",
    scopes: scopes("settings.basic", "mail"), grantScope: scope("settings.basic") },
  { id: "gmail.messages.import", group: "write", label: "Import messages", labelZh: "导入邮件", risk: "write",
    scopes: scopes("insert", "modify", "mail"), grantScope: scope("insert") },
  { id: "gmail.messages.trash", group: "write", label: "Move to trash and restore", labelZh: "移到回收站和恢复", risk: "destructive",
    scopes: scopes("modify", "mail"), grantScope: scope("modify") },
  { id: "gmail.messages.delete", group: "write", label: "Delete messages permanently", labelZh: "永久删除邮件", risk: "destructive",
    scopes: scopes("mail"), grantScope: scope("mail") },
  { id: "gmail.other.write", group: "write", label: "Other mailbox changes", labelZh: "其他邮箱更改", risk: "write",
    scopes: scopes("modify", "mail"), grantScope: scope("modify") },
  // The connector refuses long-running watches (`+watch`, push notifications); listed so the owner sees it is off.
  { id: "gmail.background.sync", group: "background", label: "Watch the mailbox in the background", labelZh: "后台同步新邮件", risk: "read", supported: false },
];

const gmailCatalog: OperationCatalog = {
  groups: [
    { id: "read", label: "Read", labelZh: "读取权限" },
    { id: "write", label: "Write and delete", labelZh: "写入和删除权限" },
  ],
  operations: gmailOperations,
};

export const GMAIL_READ_OPERATIONS = gmailOperations.filter((o) => o.risk === "read" && o.supported !== false).map((o) => o.id);
export const GMAIL_WRITE_OPERATIONS = gmailOperations.filter((o) => o.risk !== "read" && o.supported !== false).map((o) => o.id);

/** Gmail has its own catalog; the other Google products keep one read and one write operation. */
export function googleCatalog(product: GoogleProduct): OperationCatalog | undefined {
  return product === "gmail" ? gmailCatalog : undefined;
}

/** The Gmail MCP-shaped tools and the operation each performs. */
export const gmailToolOperation: Record<string, string> = {
  search_threads: "gmail.messages.read", get_thread: "gmail.messages.read", get_message: "gmail.messages.read",
  list_labels: "gmail.labels.read", list_drafts: "gmail.drafts.read", create_draft: "gmail.drafts.write",
  label_thread: "gmail.messages.modify", unlabel_thread: "gmail.messages.modify",
  label_message: "gmail.messages.modify", unlabel_message: "gmail.messages.modify",
};

/**
 * The operation of a Gmail Discovery method (`gmail.users.messages.send`), as classified for gws. `read` is the
 * method's HTTP verb being GET; unknown methods fall back to messages.read or other.write.
 */
export function gmailMethodOperation(method: string, read: boolean): string {
  const path = method.replace(/^gmail\.users\./, "");
  const [resource, ...rest] = path.split(".");
  const verb = rest.at(-1) ?? resource ?? "";
  if (resource === "settings") return read ? "gmail.labels.read" : "gmail.settings.write";
  if (resource === "labels") return read ? "gmail.labels.read" : "gmail.labels.manage";
  if (resource === "drafts") return verb === "send" ? "gmail.send" : read ? "gmail.drafts.read" : "gmail.drafts.write";
  if (read) return "gmail.messages.read";
  if (resource === "messages" || resource === "threads") {
    if (verb === "send") return "gmail.send";
    if (verb === "modify" || verb === "batchModify") return "gmail.messages.modify";
    if (verb === "trash" || verb === "untrash") return "gmail.messages.trash";
    if (verb === "delete" || verb === "batchDelete") return "gmail.messages.delete";
    if (verb === "import" || verb === "insert") return "gmail.messages.import";
  }
  return "gmail.other.write";
}

/**
 * Tool and field descriptions of Google's Gmail MCP server (gmailmcp.googleapis.com, Developer Preview),
 * copied verbatim from https://developers.google.com/workspace/gmail/api/reference/mcp (fetched 2026-11-05).
 * Google Developers documentation, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
 * Generated; edit by re-fetching the reference, not by hand.
 */
export const gmailSpec = {
  "search_threads": {
    "description": "Lists email threads from the authenticated user's Gmail account.\nThis tool can filter threads based on a query string and supports pagination. It returns a list of threads, including their IDs and related messages. Each related message contains details like a snippet of the message body, the subject, the sender, the recipients etc. The `view` parameter controls which fields are populated in the related messages. By default (or with `THREAD_VIEW_MINIMAL`), it includes subject and snippet. Use `THREAD_VIEW_METADATA_ONLY` to exclude subject and snippet. Note that the full message bodies are not returned by this tool; use the 'get_thread' tool with a thread ID to fetch the full message body if needed. Threads with excluded criteria may still appear in the results. This occurs because Gmail identifies matching messages first. For example, if you search for -is:starred, Gmail will find an entire thread if it contains at least one unstarred message, even if other emails in that same conversation are starred.",
    "fields": {
      "pageSize": "Optional. The maximum number of threads to return. If unspecified, defaults to 20. The maximum allowed value is 50.",
      "pageToken": "Optional. Page token to retrieve a specific page of results in the list. Leave empty to fetch the first page. This is primarily used for pagination to continue fetching results from where the previous `SearchThreads` call left off, especially when the number of threads matching the query exceeds the page_size limit.",
      "query": "Optional. A query string to filter the threads. Natural language queries must be pre-converted into Gmail syntax queries to use this tool. If omitted, all threads (excluding spam and trash by default) are listed.\nSupported Operators by Category:\nSender & Recipient:\n- `from:<email>` — Sent from a specific person.\n- `to:<email>` — Sent to a specific person.\n- `cc:<email>` — Specific people in Cc.\n- `bcc:<email>` — Specific people in Bcc.\n- `deliveredto:<email>` — Delivered to a specific address.\n- `list:<email>` — From a specific mailing list.\nTime & Date:\n- `after:YYYY/MM/DD` / `newer:YYYY/MM/DD` — Received after a date.\n- `before:YYYY/MM/DD` / `older:YYYY/MM/DD` — Received before a date.\n- `older_than:<duration>` — Older than a duration (for example, `1y`, `2d`).\n- `newer_than:<duration>` — Newer than a duration.\nContent:\n- `subject:<words>` — Words in the subject line.\n- `has:<type>` — Has specific content types (attachment, drive,  youtube, document).\n- `filename:<name>` — Attachment with a specific name or type.\n- `\"<word/phrase>\"` — Search for an exact word or phrase. (for example,  `\"holiday\"`, `\"holiday vacation\"`).\n- `+<word>` — Match a word exactly. (for example, `+holiday`,  `+unicorn`)\n- `rfc822msgid:<id>` — Specific message ID header.\n- `AROUND <distance>` — Find words near each other (for example, `holiday\nAROUND 10 vacation`).\nLabels & Categories:\n- `label:<name>` — Under a specific label. The tool accepts label  IDs, not display names. Use the list_labels tool to get the ID.\n- `category:<name>` — In a category (primary, social, promotions,  updates, forums, reservations, purchases).\n- `in:<label>` — Search in specific labels (archive, snoozed,  trash, sent, inbox). For example, `in:trash`, `in:inbox`. Archived and  sent messages are included by default; use `-in:archive` and `-in:sent`  to exclude them. Drafts are explicitly excluded by default by the tool.  Use `in:inbox` to restrict search to the inbox only.\n- `has:userlabels` — Has any user labels.\n- `has:nouserlabels` — Does not have any user labels.\n- `has:*-star` — Specific star colors (if enabled, for example,  `has:yellow-star`).\n- `in:draft` — Search in drafts. -in:draft means exclude drafts  from the search results.\n- `in:sent` — Search in sent messages.\n- `in:anywhere` — Search in all folders (including spam and trash).\nStatus:\n- `is:<status>` — Search by status (important, starred, unread,  read, muted).\nSize:\n- `size:<bytes>` — Specific size in bytes.\n- `larger:<size>` / `smaller:<size>` — Larger or smaller than a size (for example,  `10M` for 10 MB).\nLogic & Grouping:\n- `AND` — Match all criteria (default behavior).\n- `OR` or `{ }` — Match one or more criteria (for example, `from:amy OR\nfrom:david`, `{from:amy from:david}`).\n- `-` (minus) — Exclude criteria (for example, `-movie`).\n- `( )` — Group multiple search terms (for example,  `subject:(dinner film)`).\nExamples:\n- `subject:OneMCP Update`\n- `from:user@example.com`\n- `to:user2@example.com AND newer_than:7d`\n- `project proposal has:attachment`\n- `is:unread -in:draft`",
      "includeTrash": "Optional. Include threads from TRASH in the results. Defaults to false.",
      "view": "Optional. Controls the fields populated for threads in the thread list. Defaults to THREAD_VIEW_MINIMAL. THREAD_VIEW_MINIMAL returns id, snippet, subject, from, to, cc, date, labelIds. THREAD_VIEW_METADATA_ONLY returns id, from, to, cc, date, labelIds."
    }
  },
  "get_thread": {
    "description": "Retrieves a specific email thread from the authenticated user's Gmail account, including a list of its messages.\nThe optional `messageFormat` parameter controls the format of the messages returned. By default (or with `FULL_CONTENT`), it returns the full content of messages. Use `MINIMAL` to include only subject and snippet (excluding body). Use `METADATA_ONLY` to include only basic metadata (message ID, thread ID, labels, timestamp, and size estimate).",
    "fields": {
      "threadId": "Required. The unique identifier of the thread to fetch.",
      "messageFormat": "Optional. Specifies the format of the messages returned within the thread. Defaults to FULL_CONTENT. Note: MINIMAL format returns id, snippet, subject, from, to, cc, date, labelIds. METADATA_ONLY format returns id, from, to, cc, date, labelIds. FULL_CONTENT returns id, snippet, subject, from, to, cc, date, labelIds, attachmentIds, plaintextBody, htmlBody, attachments."
    }
  },
  "get_message": {
    "description": "Retrieves a specific email message from the authenticated user's Gmail account by its unique message ID.\nUse this tool to inspect a single, individual email when you already know its message ID. If the user wants to read a specific email in detail, check the exact wording of a message, or examine attachment metadata for a single email, this is the right tool. It is not suitable for retrieving entire conversations or viewing back-and-forth discussion threads; use the 'get_thread' tool instead. Key indicators include if the user asks for the full content of a specific message ID returned by a previous search, or if the query asks to inspect a specific individual email rather than an entire thread. Example user prompts are: \"Get the full text of message ID 18f123456789abcd.\", \"Read the latest message in that thread from Alice.\", and \"What are the attachment names in the email I just received from HR?\"\nThe optional `messageFormat` parameter controls the format of the message returned. By default (or with `FULL_CONTENT`), it returns the full content of the message. Use `MINIMAL` to include only subject and snippet (excluding body). Use `METADATA_ONLY` to include only basic metadata (message ID, thread ID, labels, timestamp, and size estimate).",
    "fields": {
      "messageId": "Required. The unique identifier of the message to fetch.",
      "messageFormat": "Optional. Specifies the format of the message returned. Defaults to FULL_CONTENT."
    }
  },
  "list_labels": {
    "description": "Lists all user-defined labels available in the authenticated user's Gmail account. Use this tool to discover the `id` of a user label before calling `label_thread`, `unlabel_thread`, `label_message`, or `unlabel_message`. System labels are not returned by this tool but can be used with their well-known IDs: 'INBOX', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT', 'CHAT', 'DRAFT', 'SENT'.",
    "fields": {
      "pageSize": "Optional. The maximum number of labels to return.",
      "pageToken": "Optional. Page token to retrieve a specific page of results in the list."
    }
  },
  "list_drafts": {
    "description": "Lists draft emails from the authenticated user's Gmail account.\nThis tool can filter drafts based on a query string and supports pagination. It returns a list of drafts, including their IDs and subjects (unless `view` is set to `DRAFT_VIEW_METADATA_ONLY`). `page_token` can be used to paginate the results. To retrieve subsequent pages of results, use the `page_token` returned in the previous response.\nThe `view` parameter controls which fields are populated in the response. By default (or with `DRAFT_VIEW_FULL`), it returns full content. Use `DRAFT_VIEW_METADATA_ONLY` to exclude sensitive content like subject and body.",
    "fields": {
      "pageSize": "Optional. The maximum number of drafts to return. If unspecified, defaults to 20. The maximum allowed value is 50.",
      "pageToken": "Optional. A token received from a previous list_drafts call to retrieve the next page of results. Leave empty to fetch the first page. This is primarily used for pagination to continue fetching results from where the previous `ListDraft` call left off, especially when the number of drafts matching the query exceeds the page_size limit.",
      "query": "Examples:\n- `subject:OneMCP Update`\n- `from:gduser1@workspacesamples.dev`\n- `to:gduser2@workspacesamples.dev AND newer_than:7d`\n- `project proposal has:attachment`\n- `is:unread`\nA space or a dash (`-`) will separate a number while a dot (`.`) will be a decimal. For example, `01.2047-100` is considered two numbers: `01.2047` and `100`.\nNote: If we want to ensure all drafts for the query are returned, we can paginate the results by making repeated calls to the tool until the response contains an empty list of drafts.",
      "view": "Optional. Controls the fields populated for drafts in the draft list. By default (or with `DRAFT_VIEW_FULL`), it returns full content, which has draft ID, threadID, to, cc, bcc, date, subject, and body. Use `DRAFT_VIEW_METADATA_ONLY` to exclude subject and body."
    }
  },
  "create_draft": {
    "description": "Creates a new draft email in the authenticated user's Gmail account.\nThis tool takes recipient addresses, a subject, and body content as inputs. If the draft is created as a reply to an existing message, the ID of the original message should be passed to the tool in the replyToMessageId field.\nReturns only the unique ID (id) of the draft message.\nLimitation: Creating drafts with attachments is not supported yet.",
    "fields": {
      "to": "Optional. The primary recipients of the email draft. Each string MUST be a valid plain email address (e.g., \"user@example.com\"). The \"Name email@example.com\" format is NOT supported by this tool.",
      "cc": "Optional. The carbon copy recipients of the email draft. Each string MUST be a valid plain email address (e.g., \"user@example.com\"). The \"Name email@example.com\" format is NOT supported by this tool.",
      "bcc": "Optional. The blind carbon copy recipients of the email draft. Each string MUST be a valid plain email address (e.g., \"user@example.com\"). The \"Name email@example.com\" format is NOT supported by this tool.",
      "subject": "Optional. The subject line of the email. Defaults to empty if not provided.",
      "body": "Optional. The main body content of the email draft. If html_body is also provided, this field is treated as the plain-text alternative.",
      "htmlBody": "The HTML content of the email draft. If provided, this will be used as the rich-text version of the email.",
      "replyToMessageId": "Optional. The ID of the message to reply to. If provided, this will be used as the reply-to message ID for the email draft, and the `body` and `html_body` will be appended to the original message body.",
      "attachments": "Optional. The attachments to include in the email. The combined size of attachments in the message cannot exceed 25MB. If you need to send files larger than 25MB, upload the file to Drive first and then insert the Drive link into body or html_body."
    }
  },
  "label_thread": {
    "description": "Adds labels to an entire thread in the authenticated user's Gmail account. This operation affects all messages currently in the thread and any future messages added to it.\nIf unsure of the thread ID, use the `search_threads` tool first.\nIf unsure of a user label's ID, use the `list_labels` tool first to discover available labels and their IDs. To add a trash label or a spam label on to a thread, please use the `apply_sensitive_thread_label` tool instead.",
    "fields": {
      "threadId": "Required. The unique identifier of the thread to add labels to.",
      "labelIds": "Required. The unique identifiers of the labels to add. Can be a system label ID (e.g., 'INBOX', 'STARRED', 'UNREAD', 'IMPORTANT') or a user-defined label ID. The tool accepts `label_ids` and not label names. Use the list_labels tool to get the corresponding label id to a display name for user-defined labels."
    }
  },
  "unlabel_thread": {
    "description": "Removes labels from an entire thread in the authenticated user's Gmail account. If unsure of the thread ID, use the `search_threads` tool first. If unsure of a user label's ID, use the `list_labels` tool first.",
    "fields": {
      "threadId": "Required. The unique identifier of the thread to remove labels from.",
      "labelIds": "Required. The unique identifiers of the labels to remove. Can be a system label ID (e.g., 'INBOX', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT') or a user-defined label ID. The tool accepts `label_ids` and not label names. Use the list_labels tool to get the corresponding label id to a display name for user-defined labels."
    }
  },
  "label_message": {
    "description": "Adds one or more labels to a specific message in the authenticated user's Gmail account.\nTo find the message ID, use tools like `search_threads` or `get_thread`. If unsure of a user label's ID, use the `list_labels` tool first to discover available labels and their IDs. To add a trash label or a spam label on to a message, please use the `apply_sensitive_message_label` tool instead.",
    "fields": {
      "messageId": "Required. The ID of the message to add the labels to.",
      "labelIds": "Required. The IDs of the labels to add. Can be a system label ID (e.g., 'INBOX', 'STARRED', 'UNREAD', 'IMPORTANT') or a user-defined label ID. The tool accepts `label_ids` and not label names. Use the list_labels tool to get the corresponding label id to a display name for user-defined labels."
    }
  },
  "unlabel_message": {
    "description": "Removes one or more labels from a specific message in the authenticated user's Gmail account. To find the message ID, use tools like `search_threads` or `get_thread`. If unsure of a user label's ID, use the `list_labels` tool first to discover available labels and their IDs.",
    "fields": {
      "messageId": "Required. The ID of the message to remove the labels from.",
      "labelIds": "Required. The IDs of the labels to remove. Can be a system label ID (e.g., 'INBOX', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT') or a user-defined label ID. The tool accepts `label_ids` and not label names. Use the list_labels tool to get the corresponding label id to a display name for user-defined labels."
    }
  }
} as const;

import { z } from "zod";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { ConnectorError, type ConnectionConfig, type Risk } from "../../connector.js";

export const remoteSettings = z.object({
  clientFile: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1).max(200)).min(1).max(30).optional(),
}).strict();

export interface RemoteSpec {
  endpoint: string;
  authOrigins: string[];
  authorizationOrigins: string[];
  scopes: string[];
  requiresClient: boolean;
  discovery?: OAuthDiscoveryState;
  risks: Record<string, Risk>;
  note?: string;
}

const risks = (read: string[], write: string[]): Record<string, Risk> => Object.fromEntries([
  ...read.map((name) => [name, "read"]), ...write.map((name) => [name, "write"]),
]);

/** Code-reviewed capability list. Upstream annotations cannot promote a write into a read. */
export function remoteSpec(connection: ConnectionConfig): RemoteSpec {
  const parsed = remoteSettings.safeParse(connection.settings ?? {});
  if (!parsed.success) throw new ConnectorError("connection_settings_invalid");
  const settings = parsed.data;
  if (connection.kind === "github") return {
    endpoint: "https://api.githubcopilot.com/mcp/",
    authOrigins: ["https://api.githubcopilot.com", "https://github.com"],
    authorizationOrigins: ["https://github.com"],
    scopes: settings.scopes ?? ["repo", "read:user"], requiresClient: true,
    discovery: {
      authorizationServerUrl: "https://github.com",
      authorizationServerMetadata: {
        issuer: "https://github.com", authorization_endpoint: "https://github.com/login/oauth/authorize",
        token_endpoint: "https://github.com/login/oauth/access_token", response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      },
    },
    risks: risks(["get_me", "search_repositories", "get_file_contents", "search_code", "search_issues", "search_pull_requests",
      "issue_read", "pull_request_read", "list_issues", "list_pull_requests", "list_branches", "list_commits", "get_commit"],
    ["issue_write", "add_issue_comment", "create_pull_request", "update_pull_request", "create_branch", "push_files", "create_or_update_file"]),
  };
  if (connection.kind === "notion") return {
    endpoint: "https://mcp.notion.com/mcp",
    authOrigins: ["https://mcp.notion.com"],
    authorizationOrigins: ["https://mcp.notion.com", "https://www.notion.so", "https://notion.so", "https://www.notion.com"],
    scopes: settings.scopes ?? [], requiresClient: false,
    risks: risks(["notion-search", "notion-fetch", "notion-get-self", "notion-get-tool-access", "notion-get-comments", "notion-get-users",
      "notion-get-teams", "notion-query-data-sources", "notion-query-multiple-data-sources", "notion-query-meeting-notes", "notion-get-async-task"],
    ["notion-create-pages", "notion-update-page", "notion-move-pages", "notion-duplicate-page", "notion-create-database",
      "notion-update-data-source", "notion-create-view", "notion-update-view", "notion-create-comment"]),
  };
  throw new ConnectorError("remote_provider_unsupported");
}

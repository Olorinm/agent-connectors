import { z } from "zod";
import type { OperationCatalog, OperationRisk, OperationSpec, PolicySetting } from "./connector.js";

export const POLICY_SETTINGS = ["allow", "ask", "deny"] as const;
export const policySettingSchema = z.enum(POLICY_SETTINGS);
export const policyInput = z.object({ settings: z.record(z.string().max(100), policySettingSchema) }).strict();

/** Connectors without their own catalog: every read tool is one operation, every write tool the other. */
export const GENERIC_CATALOG: OperationCatalog = {
  groups: [{ id: "general", label: "Operations", labelZh: "操作" }],
  operations: [
    { id: "read", group: "general", label: "Read", labelZh: "读取", risk: "read" },
    { id: "write", group: "general", label: "Write", labelZh: "写入", risk: "write" },
  ],
};

export const defaultSetting = (risk: OperationRisk): PolicySetting => risk === "read" ? "allow" : "ask";

export interface OperationView {
  id: string; label: string; labelZh: string; risk: OperationRisk; setting: PolicySetting; default: PolicySetting; available: boolean;
  unavailableReason?: "scope_required" | "not_supported"; grantable?: boolean;
  /** The scope a grant would add; for the trusted product's connect call, not for display. */
  grantScope?: string;
}

/** Effective settings: the owner's stored choices over the defaults; stale IDs from older catalogs are ignored. */
export function effectiveSettings(catalog: OperationCatalog, stored: Record<string, string>): Map<string, PolicySetting> {
  const settings = new Map<string, PolicySetting>();
  for (const operation of catalog.operations) {
    const chosen = policySettingSchema.safeParse(Object.hasOwn(stored, operation.id) ? stored[operation.id] : undefined);
    settings.set(operation.id, chosen.success ? chosen.data : defaultSetting(operation.risk));
  }
  return settings;
}

export function operationView(operation: OperationSpec, setting: PolicySetting, granted: string[] | undefined, incremental: boolean): OperationView {
  const base = { id: operation.id, label: operation.label, labelZh: operation.labelZh, risk: operation.risk, setting, default: defaultSetting(operation.risk) };
  if (operation.supported === false) return { ...base, available: false, unavailableReason: "not_supported" };
  if (operation.scopes?.length && granted && !operation.scopes.some((scope) => granted.includes(scope))) {
    const grantable = incremental && !!operation.grantScope;
    return { ...base, available: false, unavailableReason: "scope_required", grantable, ...(grantable ? { grantScope: operation.grantScope! } : {}) };
  }
  return { ...base, available: true };
}

export function policyView(catalog: OperationCatalog, settings: Map<string, PolicySetting>, granted: string[] | undefined, incremental: boolean) {
  const view = (operation: OperationSpec) => operationView(operation, settings.get(operation.id)!, granted, incremental);
  const background = catalog.operations.filter((operation) => operation.group === "background").map(view);
  return {
    groups: catalog.groups.map((group) => ({ id: group.id, label: group.label, labelZh: group.labelZh,
      operations: catalog.operations.filter((operation) => operation.group === group.id).map(view) })),
    ...(background.length ? { background } : {}),
  };
}

import { readdirSync, readFileSync } from "node:fs";

/**
 * Agent-facing guides shipped with each connector (guides/*.md). A product installs the guide of
 * every connection assigned to an Agent, e.g. as a skill, so the Agent knows the connector and its
 * CLI before the first call. `command` names the CLI the product exposes in the Agent's shell.
 */
export interface ConnectorGuide {
  name: string;
  description: string;
  command: string;
  connector: string;
  product?: string;
  /** Markdown body without the front matter. */
  body: string;
}

const directory = new URL("../guides/", import.meta.url);

export function connectorGuides(): ConnectorGuide[] {
  return readdirSync(directory).filter((file) => file.endsWith(".md")).sort().map((file) => {
    const text = readFileSync(new URL(file, directory), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!match) throw new Error(`connector_guide_invalid:${file}`);
    const fields = Object.fromEntries(match[1]!.split("\n").map((line) => {
      const index = line.indexOf(":");
      const value = line.slice(index + 1).trim();
      return [line.slice(0, index).trim(), value.startsWith('"') ? JSON.parse(value) as string : value];
    }));
    for (const key of ["name", "description", "command", "connector"]) if (!fields[key]) throw new Error(`connector_guide_invalid:${file}`);
    return { name: fields.name!, description: fields.description!, command: fields.command!, connector: fields.connector!,
      ...(fields.product ? { product: fields.product } : {}), body: text.slice(match[0].length).trim() + "\n" };
  });
}

/** The guide for a connection, by its kind and (for Google) product. */
export function connectorGuide(kind: string, product?: string) {
  return connectorGuides().find((guide) => guide.connector === kind && (guide.product === undefined || guide.product === product));
}

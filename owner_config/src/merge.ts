import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { isScalar, parse, parseDocument, stringify, type Document } from "yaml";
import iconv from "iconv-lite";
import type { Scalar } from "./types.js";

const variablePattern = /@\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

type ConfigEncoding = "utf8" | "gb18030";
type LineEnding = "\n" | "\r\n" | "\r";

interface ConfigText {
  text: string;
  encoding: ConfigEncoding;
  bom: boolean;
  lineEnding: LineEnding;
  finalNewline: boolean;
}

function kind(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function applyYamlOverrides(document: Document, value: unknown, path: (string | number)[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => applyYamlOverrides(document, item, [...path, index]));
  } else if (typeof value === "object" && value !== null) {
    Object.entries(value).forEach(([key, item]) => applyYamlOverrides(document, item, [...path, key]));
  } else {
    const node = document.getIn(path.length ? path : null, true);
    if (typeof value === "boolean" && isScalar(node) && typeof node.value === "boolean") {
      const source = node.source || String(node.value);
      node.value = value;
      node.source = source === source.toUpperCase()
        ? String(value).toUpperCase()
        : source[0] === source[0].toUpperCase()
          ? `${String(value)[0].toUpperCase()}${String(value).slice(1)}`
          : String(value);
      return;
    }
    document.setIn(path.length ? path : null, value);
  }
}

export function mergeStructured(baseline: unknown, local: unknown, path: (string | number)[] = []): unknown {
  const location = path.length ? path.join(".") : "<root>";
  if (local === null) {
    if (baseline === null) return null;
    throw new Error(`null value at ${location}`);
  }
  if (kind(local) !== kind(baseline)) {
    throw new Error(`type mismatch at ${location}: expected ${kind(baseline)}, got ${kind(local)}`);
  }
  if (Array.isArray(local) && Array.isArray(baseline)) {
    const merged = clone(baseline);
    local.forEach((value, index) => {
      if (index >= baseline.length) throw new Error(`list index out of range at ${[...path, index].join(".")}`);
      merged[index] = mergeStructured(baseline[index], value, [...path, index]);
    });
    return merged;
  }
  if (typeof local === "object" && local && typeof baseline === "object" && baseline) {
    const base = baseline as Record<string, unknown>;
    const merged = clone(base);
    for (const [key, value] of Object.entries(local)) {
      if (!(key in base)) throw new Error(`unknown key at ${[...path, key].join(".")}`);
      merged[key] = mergeStructured(base[key], value, [...path, key]);
    }
    return merged;
  }
  return local;
}

export function resolveVariables(value: unknown, variables: Record<string, Scalar>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveVariables(item, variables));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveVariables(item, variables)]));
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^@\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (exact) return lookup(exact[1], variables);
  return value.replace(variablePattern, (_, name: string) => String(lookup(name, variables)));
}

function lookup(name: string, variables: Record<string, Scalar>): Scalar {
  if (!(name in variables)) throw new Error(`undefined variable: ${name}`);
  return variables[name];
}

function parseIni(text: string): Record<string, Record<string, string | null>> {
  const result: Record<string, Record<string, string | null>> = {};
  let section: Record<string, string | null> | undefined;
  for (const raw of text.replace(/\r\n|\r/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) continue;
    const heading = line.match(/^\[([^\]]+)]$/);
    if (heading) section = result[heading[1]] = {};
    else if (section) {
      const split = line.indexOf("=");
      if (split < 0) section[line] = null;
      else section[line.slice(0, split).trim()] = line.slice(split + 1).trim();
    }
  }
  return result;
}

function lineEnding(text: string): LineEnding {
  return text.match(/\r\n|\n|\r/)?.[0] as LineEnding | undefined ?? "\n";
}

function textFormat(text: string, encoding: ConfigEncoding = "utf8", bom = false): ConfigText {
  return { text, encoding, bom, lineEnding: lineEnding(text), finalNewline: /(?:\r\n|\n|\r)$/.test(text) };
}

async function readConfigText(path: string): Promise<ConfigText> {
  const raw = await readFile(path);
  const bom = raw.subarray(0, utf8Bom.length).equals(utf8Bom);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? raw.subarray(utf8Bom.length) : raw);
    return textFormat(text, "utf8", bom);
  } catch {
    return textFormat(iconv.decode(raw, "gb18030"), "gb18030");
  }
}

export async function readConfigFile(path: string): Promise<string> {
  return (await readConfigText(path)).text;
}

function preserveTextFormat(text: string, source: ConfigText): string {
  let normalized = text.replace(/\r\n|\r/g, "\n");
  if (source.finalNewline) {
    if (!normalized.endsWith("\n")) normalized += "\n";
  } else {
    normalized = normalized.replace(/\n$/, "");
  }
  return source.lineEnding === "\n" ? normalized : normalized.replace(/\n/g, source.lineEnding);
}

function applyIniOverrides(baselineText: string, local: Record<string, Record<string, string | null>>): string {
  const parts = baselineText.split(/(\r\n|\n|\r)/);
  const lines = parts.filter((_, index) => index % 2 === 0);
  const sections = new Map<string, { start: number; end: number }>();
  let current: { name: string; start: number } | undefined;
  lines.forEach((raw, index) => {
    const heading = raw.trim().match(/^\[([^\]]+)]$/);
    if (!heading) return;
    if (current) sections.set(current.name, { start: current.start, end: index });
    current = { name: heading[1], start: index + 1 };
  });
  if (current) sections.set(current.name, { start: current.start, end: lines.length });

  for (const [section, values] of Object.entries(local)) {
    const range = sections.get(section);
    if (!range) continue;
    for (const [key, value] of Object.entries(values)) {
      if (value === null) continue;
      let target = -1;
      for (let index = range.start; index < range.end; index += 1) {
        const split = lines[index].indexOf("=");
        if (split >= 0 && lines[index].slice(0, split).trim() === key) target = index;
      }
      if (target < 0) continue;
      const split = lines[target].indexOf("=");
      const originalValue = lines[target].slice(split + 1);
      const leading = originalValue.match(/^\s*/)?.[0] ?? "";
      const trailing = originalValue.slice(leading.length).match(/\s*$/)?.[0] ?? "";
      lines[target] = `${lines[target].slice(0, split + 1)}${leading}${value}${trailing}`;
    }
  }
  lines.forEach((line, index) => { parts[index * 2] = line; });
  return parts.join("");
}

async function writeConfigText(path: string, value: ConfigText): Promise<void> {
  const content = value.encoding === "gb18030" ? iconv.encode(value.text, "gb18030") : Buffer.from(value.text, "utf8");
  const output = value.bom && value.encoding === "utf8" ? Buffer.concat([utf8Bom, content]) : content;
  await writeFile(path, output);
}

async function renderMergedConfigText(
  baselinePath: string,
  localText: string,
  variables: Record<string, Scalar>,
): Promise<ConfigText> {
  const suffix = extname(baselinePath).toLowerCase();
  const baselineInput = await readConfigText(baselinePath);
  return renderMergedConfigContents(suffix, baselineInput, localText, variables);
}

function renderMergedConfigContents(
  suffix: string,
  baselineInput: ConfigText,
  localText: string,
  variables: Record<string, Scalar>,
): ConfigText {
  const baselineText = baselineInput.text;
  let text: string;
  if (suffix === ".yaml" || suffix === ".yml") {
    const document = parseDocument(baselineText);
    const local = resolveVariables(parse(localText) ?? {}, variables);
    mergeStructured(document.toJS() ?? {}, local);
    applyYamlOverrides(document, local);
    text = document.toString({ lineWidth: 0 });
  } else if (suffix === ".json") {
    const merged = mergeStructured(JSON.parse(baselineText), resolveVariables(JSON.parse(localText.trim() || "{}"), variables));
    text = JSON.stringify(merged, null, 4) + "\n";
  } else if (suffix === ".ini") {
    const local = resolveVariables(parseIni(localText), variables) as Record<string, Record<string, string | null>>;
    mergeStructured(parseIni(baselineText), local);
    text = applyIniOverrides(baselineText, local);
  } else {
    text = localText;
  }
  return { ...baselineInput, text: suffix === ".ini" ? text : preserveTextFormat(text, baselineInput) };
}

export function validateConfigBaseline(name: string, text: string): void {
  const suffix = extname(name).toLowerCase();
  if (suffix === ".yaml" || suffix === ".yml") {
    const document = parseDocument(text);
    if (document.errors.length) throw new Error(`invalid YAML: ${document.errors[0].message}`);
  } else if (suffix === ".json") {
    try { JSON.parse(text); } catch (error) { throw new Error(`invalid JSON: ${(error as Error).message}`); }
  }
}

export function previewConfigContents(name: string, baselineText: string, localText: string, variables: Record<string, Scalar>): string {
  validateConfigBaseline(name, baselineText);
  return renderMergedConfigContents(extname(name).toLowerCase(), textFormat(baselineText), localText, variables).text;
}

async function renderMergedConfig(baselinePath: string, localPath: string, variables: Record<string, Scalar>): Promise<ConfigText> {
  return renderMergedConfigText(baselinePath, await readConfigFile(localPath), variables);
}

export async function previewConfigText(baselinePath: string, localText: string, variables: Record<string, Scalar>): Promise<string> {
  return (await renderMergedConfigText(baselinePath, localText, variables)).text;
}

export async function writeConfigFile(path: string, text: string): Promise<void> {
  let output = textFormat(text);
  try {
    const source = await readConfigText(path);
    output = { ...source, text: preserveTextFormat(text, source) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeConfigText(path, output);
}

export async function previewConfigFile(baselinePath: string, localPath: string, variables: Record<string, Scalar>): Promise<string> {
  return (await renderMergedConfig(baselinePath, localPath, variables)).text;
}

export async function mergeConfigFile(
  baselinePath: string,
  localPath: string,
  outputPath: string,
  variables: Record<string, Scalar>,
): Promise<void> {
  const rendered = await renderMergedConfig(baselinePath, localPath, variables);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeConfigText(outputPath, rendered);
}

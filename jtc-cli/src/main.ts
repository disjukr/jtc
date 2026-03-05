import { Command } from "@cliffy/command";
import { extname, resolve } from "@std/path";
import { parseTree, type ParseErrorCode, printParseErrorCode } from "jsonc-parser";
import ts from "typescript";
import { parseDocument as parseYamlDocument } from "yaml";
import denoConfig from "../deno.json" with { type: "json" };
import { check, diagnosticToPath } from "../../json-type-checker/src/check.ts";
import {
  jsonTextToRoughJson,
  pathToSpan as jsonPathToSpan,
} from "../../json-type-checker/src/json.ts";
import type { RoughJson } from "../../json-type-checker/src/rough-json.ts";
import type { Path, Span } from "../../json-type-checker/src/type.ts";
import {
  pathToSpan as yamlPathToSpan,
  yamlDocumentToRoughJson,
} from "../../json-type-checker/src/yaml.ts";

type ParsedDocumentContext = {
  roughJson: RoughJson;
  pathToSpan: (path: Path) => Span;
};

const CLI_VERSION = typeof denoConfig.version === "string" &&
    denoConfig.version.length > 0
  ? denoConfig.version
  : "0.0.0";

const command = new Command()
  .name("jtc")
  .version(CLI_VERSION)
  .description("JSON/YAML type checker")
  .command("check <file:string>", "Type-check a json/jsonc/yaml document")
  .action((_, filePath: string) => runCheck(filePath));

if (import.meta.main) {
  const args = Deno.args.length === 0 ? ["--help"] : Deno.args;
  await command.parse(args);
}

async function runCheck(inputPath: string): Promise<void> {
  const filePath = resolve(inputPath);
  const text = await Deno.readTextFile(filePath);
  const context = parseDocumentContext(filePath, text);
  const typePath = getTypePath(context.roughJson);

  if (!typePath) {
    console.error(`${filePath}: missing "$type" field`);
    Deno.exit(1);
  }

  const valueForCheck = omitTypeField(context.roughJson);
  const diagnostics = check(valueForCheck, typePath, { baseFilePath: filePath });

  for (const diagnostic of diagnostics) {
    printDiagnostic(filePath, text, context.pathToSpan, diagnostic);
  }

  if (diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)) {
    Deno.exit(1);
  }
}

function parseDocumentContext(
  filePath: string,
  text: string,
): ParsedDocumentContext {
  const ext = extname(filePath).toLowerCase();

  if (ext === ".json" || ext === ".jsonc") {
    const errors: { error: ParseErrorCode; offset: number; length: number }[] = [];
    const root = parseTree(text, errors);
    if (errors.length > 0) {
      throw new Error(formatJsonParseErrors(errors));
    }
    if (!root) {
      throw new Error("Invalid JSON/JSONC document");
    }
    const roughJson = jsonTextToRoughJson(text);
    return {
      roughJson,
      pathToSpan: (path) => jsonPathToSpan(root, path),
    };
  }

  if (ext === ".yaml" || ext === ".yml") {
    const document = parseYamlDocument(text, { keepSourceTokens: true });
    if (document.errors.length > 0) {
      const messages = document.errors.map((item) => item.message).join("\n");
      throw new Error(messages);
    }
    const roughJson = yamlDocumentToRoughJson(document);
    return {
      roughJson,
      pathToSpan: (path) => yamlPathToSpan(document, path),
    };
  }

  throw new Error(`Unsupported file extension: ${ext}`);
}

function getTypePath(roughJson: RoughJson): string | null {
  if (roughJson.type !== "object") return null;
  const typeField = roughJson.items.findLast((item) => item.key.value === "$type");
  if (!typeField || typeField.value.type !== "string") return null;
  return typeField.value.value;
}

function omitTypeField(roughJson: RoughJson): RoughJson {
  if (roughJson.type !== "object") return roughJson;
  return {
    type: "object",
    items: roughJson.items.filter((item) => item.key.value !== "$type"),
  };
}

function printDiagnostic(
  filePath: string,
  text: string,
  pathToSpan: (path: Path) => Span,
  diagnostic: ts.Diagnostic,
): void {
  const path = diagnosticToPath(diagnostic);
  const span = path ? pathToSpan(path) : findDiagnosticSpan(diagnostic);
  const { line, column } = offsetToLineColumn(text, span?.start ?? 0);
  const code = `TS${diagnostic.code}`;
  const category = diagnosticCategoryName(diagnostic.category);
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const pathText = path ? ` ${formatPath(path)}` : "";
  console.error(`${filePath}:${line}:${column} ${category} ${code}: ${message}${pathText}`);
}

function findDiagnosticSpan(diagnostic: ts.Diagnostic): Span | null {
  if (!diagnostic.file || diagnostic.start == null || diagnostic.length == null) {
    return null;
  }
  return {
    start: diagnostic.start,
    end: diagnostic.start + diagnostic.length,
  };
}

function offsetToLineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastLineStart = 0;

  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastLineStart = i + 1;
    }
  }

  return { line, column: clamped - lastLineStart + 1 };
}

function formatPath(path: Path): string {
  let result = "$";
  for (const item of path) {
    if (typeof item === "number") {
      result += `[${item}]`;
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(item)) {
      result += `.${item}`;
      continue;
    }
    result += `[${JSON.stringify(item)}]`;
  }
  return result;
}

function diagnosticCategoryName(category: ts.DiagnosticCategory): string {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
    default:
      return "error";
  }
}

function formatJsonParseErrors(
  errors: { error: ParseErrorCode; offset: number; length: number }[],
): string {
  return errors.map((item) => {
    return `${printParseErrorCode(item.error)} at ${item.offset}`;
  }).join("\n");
}

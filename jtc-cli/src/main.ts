import { Command } from "@cliffy/command";
import { extname, resolve } from "@std/path";
import ts from "typescript";
import denoConfig from "../deno.json" with { type: "json" };
import { check } from "../../json-type-checker/src/check.ts";
import {
  getTypePath,
  mapDocumentDiagnostics,
  omitTypeField,
  parseDocumentContext,
  type DocumentDiagnostic,
  type SupportedLanguageId,
} from "../../json-type-checker/src/document.ts";
import type { Path } from "../../json-type-checker/src/type.ts";
import { runLsp } from "./lsp.ts";

const CLI_VERSION = typeof denoConfig.version === "string" &&
    denoConfig.version.length > 0
  ? denoConfig.version
  : "0.0.0";

const command = new Command()
  .name("jtc")
  .version(CLI_VERSION)
  .description("JSON/YAML type checker");

command
  .command("check <file:string>", "Type-check a json/jsonc/yaml document")
  .action(async (_, filePath: string) => {
    try {
      await runCheck(filePath);
    } catch (error) {
      console.error(formatCliError(error));
      Deno.exit(1);
    }
  });

command
  .command("lsp", "Run JTC language server over stdio")
  .action(async () => {
    try {
      runLsp();
    } catch (error) {
      console.error(formatCliError(error));
      Deno.exit(1);
    }
  });

if (import.meta.main) {
  const args = Deno.args.length === 0 ? ["--help"] : Deno.args;
  await command.parse(args);
}

async function runCheck(inputPath: string): Promise<void> {
  const filePath = resolve(inputPath);
  const languageId = detectLanguageId(filePath);
  if (!languageId) {
    throw new Error(`Unsupported file extension: ${extname(filePath).toLowerCase()}`);
  }

  const text = await Deno.readTextFile(filePath);
  const context = parseDocumentContext(languageId, text, { strict: true });
  const typePath = getTypePath(context.roughJson);
  if (!typePath) {
    throw new Error(`${filePath}: missing "$type" field`);
  }

  const valueForCheck = omitTypeField(context.roughJson);
  const tsDiagnostics = check(valueForCheck, typePath, { baseFilePath: filePath });
  const diagnostics = mapDocumentDiagnostics(tsDiagnostics, context.pathToSpan);

  for (const diagnostic of diagnostics) {
    printDiagnostic(filePath, text, diagnostic);
  }

  if (diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)) {
    Deno.exit(1);
  }
}

function detectLanguageId(filePath: string): SupportedLanguageId | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".jsonc") return "jsonc";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return null;
}

function printDiagnostic(
  filePath: string,
  text: string,
  diagnostic: DocumentDiagnostic,
): void {
  const code = `TS${diagnostic.code}`;
  const category = diagnosticCategoryName(diagnostic.category);
  const pathText = diagnostic.path ? ` ${formatPath(diagnostic.path)}` : "";

  if (diagnostic.span) {
    const { line, column } = offsetToLineColumn(text, diagnostic.span.start);
    console.error(
      `${filePath}:${line}:${column} ${category} ${code}: ${diagnostic.message}${pathText}`,
    );
    return;
  }

  console.error(`${filePath} ${category} ${code}: ${diagnostic.message}`);
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

function formatCliError(error: unknown): string {
  if (error instanceof Error) return `jtc: ${error.message}`;
  return `jtc: ${String(error)}`;
}

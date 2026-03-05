import { parseTree, type ParseErrorCode, printParseErrorCode } from "jsonc-parser";
import ts from "typescript";
import { parseDocument as parseYamlDocument } from "yaml";
import { diagnosticToPath } from "./check.ts";
import {
  jsonTextToRoughJson,
  pathToSpan as jsonPathToSpan,
} from "./json.ts";
import type { RoughJson } from "./rough-json.ts";
import type { Path, Span } from "./type.ts";
import {
  pathToSpan as yamlPathToSpan,
  yamlDocumentToRoughJson,
} from "./yaml.ts";

export type SupportedLanguageId = "json" | "jsonc" | "yaml";

export interface ParseDocumentOptions {
  strict?: boolean;
}

export interface ParsedDocumentContext {
  roughJson: RoughJson;
  pathToSpan: (path: Path) => Span;
}

export interface DocumentDiagnostic {
  category: ts.DiagnosticCategory;
  code: number;
  message: string;
  path: Path | null;
  span: Span | null;
}

export function isSupportedLanguage(languageId: string): languageId is SupportedLanguageId {
  return languageId === "json" || languageId === "jsonc" || languageId === "yaml";
}

export function parseDocumentContext(
  languageId: SupportedLanguageId,
  text: string,
  options: ParseDocumentOptions = {},
): ParsedDocumentContext {
  if (languageId === "json" || languageId === "jsonc") {
    const errors: { error: ParseErrorCode; offset: number; length: number }[] = [];
    const root = parseTree(text, errors);
    if (options.strict && errors.length > 0) {
      throw new Error(formatJsonParseErrors(errors));
    }
    if (!root) {
      if (options.strict) {
        throw new Error("Invalid JSON/JSONC document");
      }
      return {
        roughJson: { type: "null" },
        pathToSpan: () => ({ start: 0, end: 0 }),
      };
    }

    const roughJson = jsonTextToRoughJson(text);
    return {
      roughJson,
      pathToSpan: (path) => jsonPathToSpan(root, path),
    };
  }

  const yamlDocument = parseYamlDocument(text, { keepSourceTokens: true });
  if (options.strict && yamlDocument.errors.length > 0) {
    throw new Error(yamlDocument.errors.map((item) => item.message).join("\n"));
  }
  const roughJson = yamlDocumentToRoughJson(yamlDocument);
  return {
    roughJson,
    pathToSpan: (path) => yamlPathToSpan(yamlDocument, path),
  };
}

export function getTypePath(roughJson: RoughJson): string | null {
  if (roughJson.type !== "object") return null;
  const typeField = roughJson.items.findLast((item) => item.key.value === "$type");
  if (!typeField || typeField.value.type !== "string") return null;
  return typeField.value.value;
}

export function omitTypeField(roughJson: RoughJson): RoughJson {
  if (roughJson.type !== "object") return roughJson;
  return {
    type: "object",
    items: roughJson.items.filter((item) => item.key.value !== "$type"),
  };
}

export function mapDocumentDiagnostics(
  diagnostics: ts.Diagnostic[],
  pathToSpan: (path: Path) => Span,
): DocumentDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const path = diagnosticToPath(diagnostic);
    return {
      category: diagnostic.category,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      path,
      span: path ? pathToSpan(path) : null,
    };
  });
}

function formatJsonParseErrors(
  errors: { error: ParseErrorCode; offset: number; length: number }[],
): string {
  return errors.map((item) => {
    return `${printParseErrorCode(item.error)} at ${item.offset}`;
  }).join("\n");
}

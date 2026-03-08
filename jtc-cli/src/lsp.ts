import { fromFileUrl, toFileUrl } from "@std/path";
import ts from "typescript";
import {
  createConnection,
  type DefinitionLink,
  type Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import process from "node:process";
import {
  check,
  type CheckFileSystem,
} from "../../json-type-checker/src/check.ts";
import { findDefinition } from "../../json-type-checker/src/definition.ts";
import {
  getTypePath,
  isSupportedLanguage,
  mapDocumentDiagnostics,
  omitTypeField,
  parseDocumentContext,
} from "../../json-type-checker/src/document.ts";

const DIAGNOSTIC_SOURCE = "jtc";

type OpenDocument = {
  uri: string;
  languageId: string;
  version: number;
  text: string;
};

export function runLsp(): void {
  const connection = createConnection(
    ProposedFeatures.all,
    process.stdin,
    process.stdout,
  );
  const openDocuments = new Map<string, OpenDocument>();
  let shutdownRequested = false;

  connection.onInitialize(() => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        definitionProvider: true,
      },
      serverInfo: {
        name: "jtc",
      },
    };
  });

  connection.onDidOpenTextDocument((event) => {
    const document: OpenDocument = {
      uri: event.textDocument.uri,
      languageId: event.textDocument.languageId,
      version: event.textDocument.version,
      text: event.textDocument.text,
    };
    openDocuments.set(document.uri, document);
    void publishDiagnostics(connection, openDocuments, document.uri);
  });

  connection.onDidChangeTextDocument((event) => {
    const current = openDocuments.get(event.textDocument.uri);
    if (!current) return;
    const latestChange = event.contentChanges.at(-1);
    if (!latestChange) return;

    const next: OpenDocument = {
      ...current,
      version: event.textDocument.version,
      text: latestChange.text,
    };
    openDocuments.set(next.uri, next);
    void publishDiagnostics(connection, openDocuments, next.uri);
  });

  connection.onDidCloseTextDocument((event) => {
    openDocuments.delete(event.textDocument.uri);
    connection.sendDiagnostics({
      uri: event.textDocument.uri,
      diagnostics: [],
    });
  });

  connection.onDefinition(async (params) => {
    const document = openDocuments.get(params.textDocument.uri);
    if (!document) return null;
    return await buildDefinitionLinks(
      openDocuments,
      document,
      params.position.line,
      params.position.character,
    );
  });

  connection.onShutdown(() => {
    shutdownRequested = true;
  });

  connection.onNotification("exit", () => {
    Deno.exit(shutdownRequested ? 0 : 1);
  });

  connection.listen();
}

async function publishDiagnostics(
  connection: ReturnType<typeof createConnection>,
  openDocuments: Map<string, OpenDocument>,
  uri: string,
): Promise<void> {
  const document = openDocuments.get(uri);
  if (!document) return;

  const diagnostics = await buildDiagnostics(document);
  const latest = openDocuments.get(uri);
  if (!latest || latest.version !== document.version) return;

  connection.sendDiagnostics({
    uri,
    version: document.version,
    diagnostics,
  });
}

async function buildDiagnostics(document: OpenDocument): Promise<Diagnostic[]> {
  try {
    if (!isSupportedLanguage(document.languageId)) return [];
    const filePath = uriToFilePath(document.uri);
    if (!filePath) return [];

    const context = parseDocumentContext(document.languageId, document.text);
    const typePath = getTypePath(context.roughJson);
    if (!typePath) return [];

    const valueForCheck = omitTypeField(context.roughJson);
    const tsDiagnostics = check(valueForCheck, typePath, {
      baseFilePath: filePath,
    });
    const mappedDiagnostics = mapDocumentDiagnostics(
      tsDiagnostics,
      context.pathToSpan,
    );

    return mappedDiagnostics.map((item) => {
      return {
        range: item.span
          ? spanToRange(document.text, item.span.start, item.span.end)
          : fullTextRange(document.text),
        severity: toLspSeverity(item.category),
        message: item.message,
        source: DIAGNOSTIC_SOURCE,
        code: item.code,
      };
    });
  } catch (error) {
    return [
      {
        range: fullTextRange(document.text),
        severity: DiagnosticSeverity.Error,
        message: toInternalErrorMessage(error),
        source: DIAGNOSTIC_SOURCE,
        code: "jtc-internal",
      },
    ];
  }
}

async function buildDefinitionLinks(
  openDocuments: Map<string, OpenDocument>,
  document: OpenDocument,
  line: number,
  character: number,
): Promise<DefinitionLink[] | null> {
  try {
    if (!isSupportedLanguage(document.languageId)) return null;
    const filePath = uriToFilePath(document.uri);
    if (!filePath) return null;
    const fs = createOpenDocumentOverlayFs(openDocuments);

    const context = parseDocumentContext(document.languageId, document.text);
    const typePath = getTypePath(context.roughJson);
    if (!typePath) return null;

    const offset = positionToOffset(document.text, line, character);
    const path = context.offsetToPath(offset);
    if (!path || path.length === 0) return null;

    const target = findDefinition(path, typePath, {
      baseFilePath: filePath,
      fs,
    });
    if (!target) return null;

    const targetUri = toFileUrl(target.filePath).href;
    const targetText = fs.readFile(target.filePath);
    if (targetText == null) return null;

    return [{
      targetUri,
      targetRange: spanToRange(
        targetText,
        target.targetSpan.start,
        target.targetSpan.end,
      ),
      targetSelectionRange: spanToRange(
        targetText,
        target.targetSelectionSpan.start,
        target.targetSelectionSpan.end,
      ),
    }];
  } catch {
    return null;
  }
}

function toLspSeverity(category: ts.DiagnosticCategory): DiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return DiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Warning:
      return DiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Suggestion:
      return DiagnosticSeverity.Hint;
    case ts.DiagnosticCategory.Message:
      return DiagnosticSeverity.Information;
    default:
      return DiagnosticSeverity.Error;
  }
}

function toInternalErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `JTC failed: ${message}`;
}

function uriToFilePath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return null;
    return fromFileUrl(url);
  } catch {
    return null;
  }
}

function fullTextRange(text: string): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  const end = offsetToPosition(text, text.length);
  return {
    start: { line: 0, character: 0 },
    end,
  };
}

function spanToRange(
  text: string,
  startOffset: number,
  endOffset: number,
): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  const safeStart = clamp(startOffset, 0, text.length);
  const safeEnd = clamp(endOffset, safeStart, text.length);
  return {
    start: offsetToPosition(text, safeStart),
    end: offsetToPosition(text, safeEnd),
  };
}

function positionToOffset(
  text: string,
  line: number,
  character: number,
): number {
  const safeLine = Math.max(0, line);
  const safeCharacter = Math.max(0, character);
  let currentLine = 0;
  let index = 0;

  while (index < text.length && currentLine < safeLine) {
    if (text.charCodeAt(index) === 10) {
      currentLine += 1;
    }
    index += 1;
  }

  let lineEnd = index;
  while (lineEnd < text.length && text.charCodeAt(lineEnd) !== 10) {
    lineEnd += 1;
  }

  return clamp(index + safeCharacter, index, lineEnd);
}

function offsetToPosition(
  text: string,
  offset: number,
): { line: number; character: number } {
  const clamped = clamp(offset, 0, text.length);
  let line = 0;
  let lastLineStart = 0;

  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastLineStart = i + 1;
    }
  }

  return {
    line,
    character: clamped - lastLineStart,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createOpenDocumentOverlayFs(
  openDocuments: Map<string, OpenDocument>,
): CheckFileSystem {
  const openFileTexts = new Map<string, string>();

  for (const document of openDocuments.values()) {
    const filePath = uriToFilePath(document.uri);
    if (!filePath) continue;
    openFileTexts.set(pathKey(filePath), document.text);
  }

  return {
    fileExists(filePath: string): boolean {
      if (openFileTexts.has(pathKey(filePath))) return true;
      try {
        return Deno.statSync(filePath).isFile;
      } catch {
        return false;
      }
    },
    readFile(filePath: string): string | undefined {
      const openText = openFileTexts.get(pathKey(filePath));
      if (openText != null) return openText;
      try {
        return Deno.readTextFileSync(filePath);
      } catch {
        return undefined;
      }
    },
  };
}

function pathKey(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  return Deno.build.os === "windows" ? normalized.toLowerCase() : normalized;
}

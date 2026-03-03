import { dirname, extname, join, normalize } from "@std/path/posix";
import { parseTree } from "jsonc-parser";
import ts from "typescript";
import * as vscode from "vscode";
import { parseDocument as parseYamlDocument } from "yaml";
import {
  check,
  type CheckFileSystem,
  diagnosticToPath,
} from "@disjukr/jtc/check";
import {
  jsonTextToRoughJson,
  pathToSpan as jsonPathToSpan,
} from "@disjukr/jtc/json";
import type { RoughJson } from "@disjukr/jtc/rough-json";
import type { Path, Span } from "@disjukr/jtc/type";
import {
  pathToSpan as yamlPathToSpan,
  yamlDocumentToRoughJson,
} from "@disjukr/jtc/yaml";

const DIAGNOSTIC_SOURCE = "jtc";
const TS_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts"];

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("jtc");
  context.subscriptions.push(collection);

  const refresh = async (document: vscode.TextDocument): Promise<void> => {
    if (!isSupportedLanguage(document.languageId)) {
      collection.delete(document.uri);
      return;
    }

    const version = document.version;
    const diagnostics = await buildDiagnostics(document);

    const latest = vscode.workspace.textDocuments.find((item) =>
      item.uri.toString() === document.uri.toString()
    );
    if (!latest || latest.version !== version) return;

    collection.set(document.uri, diagnostics);
  };

  for (const document of vscode.workspace.textDocuments) {
    void refresh(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) =>
      void refresh(document)
    ),
    vscode.workspace.onDidChangeTextDocument((event) =>
      void refresh(event.document)
    ),
    vscode.workspace.onDidCloseTextDocument((document) =>
      collection.delete(document.uri)
    ),
  );
}

export function deactivate(): void {
  // noop
}

async function buildDiagnostics(
  document: vscode.TextDocument,
): Promise<vscode.Diagnostic[]> {
  try {
    const context = parseDocumentContext(document);
    if (!context) return [];

    const typePath = getTypePath(context.roughJson);
    if (!typePath) return [];

    const valueForCheck = omitTypeField(context.roughJson);
    const checkOptions = await createCheckOptions(document, typePath);
    const tsDiagnostics = check(valueForCheck, checkOptions.typePath, {
      baseFilePath: checkOptions.baseFilePath,
      fs: checkOptions.fs,
      compilerOptions: checkOptions.compilerOptions,
      preferFileSystemOnly: true,
    });

    return tsDiagnostics.map((diagnostic) =>
      toVsCodeDiagnostic(diagnostic, document, context.pathToSpan)
    );
  } catch (err) {
    return [toInternalErrorDiagnostic(document, err)];
  }
}

type ParsedDocumentContext = {
  roughJson: RoughJson;
  pathToSpan: (path: Path) => Span;
};

type CheckRunOptions = {
  typePath: string;
  baseFilePath: string;
  fs?: CheckFileSystem;
  compilerOptions?: ts.CompilerOptions;
};

function parseDocumentContext(
  document: vscode.TextDocument,
): ParsedDocumentContext | null {
  const text = document.getText();

  if (document.languageId === "json" || document.languageId === "jsonc") {
    const root = parseTree(text);
    const roughJson = jsonTextToRoughJson(text);
    return {
      roughJson,
      pathToSpan: (path) => {
        if (!root) return { start: 0, end: 0 };
        return jsonPathToSpan(root, path);
      },
    };
  }

  if (document.languageId === "yaml") {
    const yamlDocument = parseYamlDocument(text, { keepSourceTokens: true });
    const roughJson = yamlDocumentToRoughJson(yamlDocument);
    return {
      roughJson,
      pathToSpan: (path) => yamlPathToSpan(yamlDocument, path),
    };
  }

  return null;
}

function getTypePath(roughJson: RoughJson): string | null {
  if (roughJson.type !== "object") return null;
  const typeField = roughJson.items.findLast((item) =>
    item.key.value === "$type"
  );
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

async function createCheckOptions(
  document: vscode.TextDocument,
  typePath: string,
): Promise<CheckRunOptions> {
  if (document.uri.scheme === "file") {
    return {
      typePath,
      baseFilePath: document.uri.fsPath,
    };
  }

  const parsed = parseTypePath(typePath);
  const moduleUri = await resolveModuleUri(document.uri, parsed.modulePath);
  if (!moduleUri) {
    throw new Error(`Cannot resolve module in $type: ${parsed.modulePath}`);
  }

  const allFiles = await collectTypeScriptFiles(moduleUri);
  const baseFilePath = uriToVirtualPath(document.uri);
  const fs = createInMemoryFs(allFiles);
  const typePathForCheck = `${uriToVirtualPath(moduleUri)}#${parsed.typeName}`;
  const compilerOptions = await loadCompilerOptionsFromTsconfig(document.uri);

  return {
    typePath: typePathForCheck,
    baseFilePath,
    fs,
    compilerOptions,
  };
}

async function collectTypeScriptFiles(
  entryUri: vscode.Uri,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const queue: vscode.Uri[] = [entryUri];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;

    const key = current.toString();
    if (seen.has(key)) continue;
    seen.add(key);

    const text = await readTextFile(current);
    if (text == null) continue;

    map.set(uriToVirtualPath(current), text);

    const references = collectReferencedSpecifiers(text);
    for (const specifier of references) {
      const resolvedBase = resolveSpecifierUri(current, specifier);
      if (!resolvedBase) continue;
      const nextUri = await resolveExistingTypeScriptUri(resolvedBase);
      if (nextUri) queue.push(nextUri);
    }
  }

  return map;
}

function collectReferencedSpecifiers(text: string): string[] {
  const info = ts.preProcessFile(text, true, true);
  return [
    ...info.importedFiles.map((item) => item.fileName),
    ...info.referencedFiles.map((item) => item.fileName),
    ...info.typeReferenceDirectives.map((item) => item.fileName),
  ];
}

async function resolveModuleUri(
  fromDocument: vscode.Uri,
  modulePath: string,
): Promise<vscode.Uri | null> {
  const asSpecifier = resolveSpecifierUri(fromDocument, modulePath);
  if (!asSpecifier) return null;
  return await resolveExistingTypeScriptUri(asSpecifier);
}

function resolveSpecifierUri(
  fromUri: vscode.Uri,
  specifier: string,
): vscode.Uri | null {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const path = normalize(join(dirname(fromUri.path), specifier));
    return fromUri.with({ path });
  }

  if (specifier.startsWith("/")) {
    return fromUri.with({ path: normalize(specifier) });
  }

  if (hasUriScheme(specifier)) {
    try {
      return vscode.Uri.parse(specifier);
    } catch {
      return null;
    }
  }

  return null;
}

async function resolveExistingTypeScriptUri(
  uri: vscode.Uri,
): Promise<vscode.Uri | null> {
  if (hasTypeScriptExtension(uri.path)) {
    return await fileExists(uri) ? uri : null;
  }

  for (const extension of TS_EXTENSIONS) {
    const direct = uri.with({ path: `${uri.path}${extension}` });
    if (await fileExists(direct)) return direct;
  }

  for (const extension of TS_EXTENSIONS) {
    const indexFile = uri.with({
      path: `${normalize(join(uri.path, "index"))}${extension}`,
    });
    if (await fileExists(indexFile)) return indexFile;
  }

  return null;
}

function hasTypeScriptExtension(path: string): boolean {
  const ext = extname(path);
  return TS_EXTENSIONS.includes(ext) || path.endsWith(".d.ts");
}

function createInMemoryFs(files: Map<string, string>): CheckFileSystem {
  const normalizedMap = new Map<string, string>();
  const insensitiveMap = new Map<string, string>();
  for (const [path, text] of files) {
    const normalized = normalizeFsPath(path);
    normalizedMap.set(normalized, text);
    insensitiveMap.set(normalized.toLowerCase(), text);
  }

  const read = (path: string): string | undefined => {
    const normalized = normalizeFsPath(path);
    return normalizedMap.get(normalized) ?? insensitiveMap.get(normalized.toLowerCase());
  };

  const exists = (path: string): boolean => {
    return read(path) != null;
  }

  return {
    fileExists(path: string): boolean {
      return exists(path);
    },
    readFile(path: string): string | undefined {
      return read(path);
    },
    findConfigFile(searchStart: string): string | undefined {
      let current = normalizeFsPath(searchStart);
      while (true) {
        const candidate = normalizeFsPath(join(current, "tsconfig.json"));
        if (exists(candidate)) return candidate;
        const parent = normalizeFsPath(dirname(current));
        if (parent === current) break;
        current = parent;
      }
    },
  };
}

async function loadCompilerOptionsFromTsconfig(
  documentUri: vscode.Uri,
): Promise<ts.CompilerOptions | undefined> {
  const tsconfigUri = await findNearestTsconfigUri(documentUri);
  if (!tsconfigUri) return undefined;

  const text = await readTextFile(tsconfigUri);
  if (text == null) return undefined;

  const parsed = ts.parseConfigFileTextToJson(tsconfigUri.toString(), text);
  if (parsed.error || !parsed.config) return undefined;

  const converted = ts.convertCompilerOptionsFromJson(
    parsed.config.compilerOptions ?? {},
    dirname(uriToVirtualPath(tsconfigUri)),
    tsconfigUri.toString(),
  );

  if (converted.errors.length > 0) return undefined;
  return converted.options;
}

async function findNearestTsconfigUri(
  startUri: vscode.Uri,
): Promise<vscode.Uri | null> {
  let current = normalize(startUri.path);
  if (!current.endsWith("/")) {
    current = dirname(current);
  }

  while (true) {
    const candidate = startUri.with({
      path: normalize(join(current, "tsconfig.json")),
    });
    if (await fileExists(candidate)) return candidate;
    const parent = normalize(dirname(current));
    if (parent === current) return null;
    current = parent;
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.File;
  } catch {
    return false;
  }
}

async function readTextFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function parseTypePath(
  typePath: string,
): { modulePath: string; typeName: string } {
  const hashIndex = typePath.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex >= typePath.length - 1) {
    throw new Error(
      "Invalid $type format. Expected ./path/to/file.ts#TypeName",
    );
  }
  return {
    modulePath: typePath.slice(0, hashIndex),
    typeName: typePath.slice(hashIndex + 1),
  };
}

function uriToVirtualPath(uri: vscode.Uri): string {
  const scheme = encodeURIComponent(uri.scheme);
  const authority = uri.authority
    ? `/${encodeURIComponent(uri.authority)}`
    : "";
  return normalizeFsPath(`/${scheme}${authority}${uri.path}`);
}

function normalizeFsPath(path: string): string {
  return normalize(path.replaceAll("\\", "/"));
}

function hasUriScheme(text: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text);
}

function toVsCodeDiagnostic(
  diagnostic: ts.Diagnostic,
  document: vscode.TextDocument,
  pathToSpan: (path: Path) => Span,
): vscode.Diagnostic {
  const path = diagnosticToPath(diagnostic);
  const range = path
    ? spanToRange(document, pathToSpan(path))
    : fullDocumentRange(document);

  const result = new vscode.Diagnostic(
    range,
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    toVsCodeSeverity(diagnostic.category),
  );

  result.source = DIAGNOSTIC_SOURCE;
  result.code = String(diagnostic.code);
  return result;
}

function toVsCodeSeverity(
  category: ts.DiagnosticCategory,
): vscode.DiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return vscode.DiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Warning:
      return vscode.DiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Suggestion:
      return vscode.DiagnosticSeverity.Hint;
    case ts.DiagnosticCategory.Message:
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function spanToRange(document: vscode.TextDocument, span: Span): vscode.Range {
  const startOffset = clamp(span.start, 0, document.getText().length);
  const endOffset = clamp(span.end, startOffset, document.getText().length);
  return new vscode.Range(
    document.positionAt(startOffset),
    document.positionAt(endOffset),
  );
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const end = document.positionAt(document.getText().length);
  return new vscode.Range(new vscode.Position(0, 0), end);
}

function toInternalErrorDiagnostic(
  document: vscode.TextDocument,
  err: unknown,
): vscode.Diagnostic {
  const message = err instanceof Error ? err.message : String(err);
  const diagnostic = new vscode.Diagnostic(
    fullDocumentRange(document),
    `JTC failed: ${message}`,
    vscode.DiagnosticSeverity.Error,
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = "jtc-internal";
  return diagnostic;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isSupportedLanguage(languageId: string): boolean {
  return languageId === "json" || languageId === "jsonc" ||
    languageId === "yaml";
}

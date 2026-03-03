import ts from "typescript";
import { dirname, join, relative } from "@std/path/posix";
import type { RoughJson } from "./rough-json.ts";
import type { Path } from "./type.ts";

export interface CheckFileSystem {
  fileExists(path: string): boolean;
  readFile(path: string): string | undefined;
  findConfigFile?(searchStart: string): string | undefined;
}

export interface CheckOptions {
  baseFilePath?: string;
  fs?: CheckFileSystem;
  compilerOptions?: ts.CompilerOptions;
  preferFileSystemOnly?: boolean;
}

export function check(
  roughJson: RoughJson,
  typePath: string,
  baseFilePathOrOptions?: string | CheckOptions,
): ts.Diagnostic[] {
  const options = toCheckOptions(baseFilePathOrOptions);
  const baseFilePath = options.baseFilePath;
  const { modulePath, typeName } = parseTypePath(typePath);
  const entryFile = resolveVirtualEntryPath(baseFilePath);
  const entryDir = dirname(entryFile);
  const moduleSpecifier = resolveModuleSpecifier(modulePath, entryDir);
  const sourceText = buildCheckSource(roughJson, moduleSpecifier, typeName);

  const compilerOptions = resolveCompilerOptions(options);
  const fs = options.fs;
  const preferFsOnly = options.preferFileSystemOnly === true && fs != null;

  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists(fileName) {
      if (fileName === entryFile) return true;
      if (fs?.fileExists(fileName)) return true;
      if (preferFsOnly) return false;
      return baseHost.fileExists(fileName);
    },
    readFile(fileName) {
      if (fileName === entryFile) return sourceText;
      const text = fs?.readFile(fileName);
      if (text != null) return text;
      if (preferFsOnly) return undefined;
      return baseHost.readFile(fileName);
    },
    getSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) {
      if (fileName === entryFile) {
        return ts.createSourceFile(fileName, sourceText, languageVersion, true);
      }
      return baseHost.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
  };

  const program = ts.createProgram([entryFile], compilerOptions, host);
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
}

function toCheckOptions(baseFilePathOrOptions?: string | CheckOptions): CheckOptions {
  if (typeof baseFilePathOrOptions === "string") {
    return { baseFilePath: baseFilePathOrOptions };
  }
  return baseFilePathOrOptions ?? {};
}

export function diagnosticToPath(diagnostic: ts.Diagnostic): Path | null {
  const candidates = getDiagnosticLocations(diagnostic);
  for (const candidate of candidates) {
    const path = sourceLocationToPath(candidate.file, candidate.start);
    if (path) return path;
  }
  return null;
}

function parseTypePath(
  typePath: string,
): { modulePath: string; typeName: string } {
  const hashIndex = typePath.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex >= typePath.length - 1) {
    throw new Error(
      "Invalid typePath. Expected format: ./path/to/file.ts#TypeName",
    );
  }
  return {
    modulePath: typePath.slice(0, hashIndex),
    typeName: typePath.slice(hashIndex + 1),
  };
}

function resolveVirtualEntryPath(baseFilePath?: string): string {
  const normalizedBasePath = baseFilePath && baseFilePath.length > 0
    ? toPosixPath(baseFilePath)
    : undefined;
  const baseDir = normalizedBasePath
    ? dirname(normalizedBasePath)
    : Deno.cwd();
  return toPosixPath(join(baseDir, "__jtc_check__.ts"));
}

function resolveModuleSpecifier(modulePath: string, entryDir: string): string {
  const normalized = toPosixPath(modulePath);

  if (isRelativeSpecifier(normalized)) {
    return normalized;
  }

  if (isAbsolutePath(normalized)) {
    const rel = toPosixPath(relative(entryDir, normalized));
    return ensureRelativeSpecifier(rel);
  }

  return modulePath;
}

function isAbsolutePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  return /^[A-Za-z]:\//.test(path);
}

function isRelativeSpecifier(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

function ensureRelativeSpecifier(path: string): string {
  if (isRelativeSpecifier(path)) return path;
  return `./${path}`;
}

function buildCheckSource(
  roughJson: RoughJson,
  modulePath: string,
  typeName: string,
): string {
  const valueExpr = roughJsonToTsExpression(roughJson);
  return [
    `import type { ${typeName} } from ${JSON.stringify(modulePath)};`,
    "",
    `const value: ${typeName} = ${valueExpr};`,
    "void value;",
    "",
  ].join("\n");
}

function roughJsonToTsExpression(value: RoughJson): string {
  switch (value.type) {
    case "null":
      return "null";
    case "boolean":
      return value.value ? "true" : "false";
    case "number":
      return value.text;
    case "string":
      return JSON.stringify(value.value);
    case "array":
      return `[${
        value.items.map((item) => roughJsonToTsExpression(item)).join(", ")
      }]`;
    case "object":
      return `{ ${
        value.items.map((item) =>
          `${JSON.stringify(item.key.value)}: ${
            roughJsonToTsExpression(item.value)
          }`
        ).join(", ")
      } }`;
  }
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function resolveCompilerOptions(options: CheckOptions): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    noEmit: true,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    allowImportingTsExtensions: true,
  };

  if (options.compilerOptions) {
    return {
      ...defaults,
      ...options.compilerOptions,
      noEmit: true,
      allowImportingTsExtensions: true,
    };
  }

  const tsconfigPath = findNearestTsconfigPath(options.baseFilePath, options.fs);
  if (!tsconfigPath) return defaults;

  const read = options.fs?.readFile ?? ((path: string) => ts.sys.readFile(path));
  const configResult = ts.readConfigFile(tsconfigPath, read);
  if (configResult.error) return defaults;

  const configHost = options.fs ? {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: options.fs.fileExists,
    readFile: options.fs.readFile,
  } : ts.sys;

  const parsed = ts.parseJsonConfigFileContent(
    configResult.config,
    configHost,
    dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );

  if (parsed.errors.length > 0) return defaults;

  return {
    ...defaults,
    ...parsed.options,
    noEmit: true,
    allowImportingTsExtensions: true,
  };
}

function findNearestTsconfigPath(
  baseFilePath?: string,
  fs?: CheckFileSystem,
): string | undefined {
  const normalizedBasePath = baseFilePath && baseFilePath.length > 0
    ? toPosixPath(baseFilePath)
    : undefined;
  const searchStart = normalizedBasePath
    ? dirname(normalizedBasePath)
    : Deno.cwd();

  if (fs?.findConfigFile) {
    return fs.findConfigFile(searchStart);
  }

  const exists = fs?.fileExists ?? ts.sys.fileExists;
  return ts.findConfigFile(searchStart, exists, "tsconfig.json");
}

function getDiagnosticLocations(
  diagnostic: ts.Diagnostic,
): { file: ts.SourceFile; start: number }[] {
  const locations: { file: ts.SourceFile; start: number }[] = [];

  if (diagnostic.file && typeof diagnostic.start === "number") {
    locations.push({ file: diagnostic.file, start: diagnostic.start });
  }

  for (const info of diagnostic.relatedInformation ?? []) {
    if (info.file && typeof info.start === "number") {
      locations.push({ file: info.file, start: info.start });
    }
  }

  return locations;
}

function sourceLocationToPath(file: ts.SourceFile, start: number): Path | null {
  const token = getTokenAtPosition(file, start);
  const valueDecl = findNearestValueDeclaration(token) ??
    findValueDeclarationInFile(file);
  const root = valueDecl?.initializer;
  if (!root) return null;

  if (start < root.getStart(file) || start >= root.getEnd()) {
    return null;
  }

  const path: Path = [];
  let current: ts.Node | undefined = token;

  while (current && current !== root) {
    if (ts.isPropertyAssignment(current)) {
      const key = propertyNameToPathItem(current.name);
      if (key == null) return null;
      path.push(key);
      current = current.parent;
      continue;
    }

    const parent: ts.Node | undefined = current.parent;
    if (!parent) break;

    if (ts.isArrayLiteralExpression(parent)) {
      const index = parent.elements.indexOf(current as ts.Expression);
      if (index >= 0) path.push(index);
    }

    current = parent;
  }

  path.reverse();
  return path;
}

function getTokenAtPosition(file: ts.SourceFile, position: number): ts.Node {
  let current: ts.Node = file;

  while (true) {
    let next: ts.Node | undefined;
    current.forEachChild((child) => {
      if (next) return;
      if (position >= child.getFullStart() && position < child.getEnd()) {
        next = child;
      }
    });

    if (!next) return current;
    current = next;
  }
}

function findNearestValueDeclaration(
  node: ts.Node | undefined,
): ts.VariableDeclaration | undefined {
  let current = node;
  while (current) {
    if (isValueDeclaration(current)) return current;
    current = current.parent;
  }
}

function findValueDeclarationInFile(
  file: ts.SourceFile,
): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isValueDeclaration(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return found;
}

function isValueDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "value" &&
    node.initializer != null;
}

function propertyNameToPathItem(name: ts.PropertyName): string | number | null {
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isNumericLiteral(name)) return Number(name.text);
  return null;
}

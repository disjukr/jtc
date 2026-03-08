import { dirname, join, relative } from "@std/path/posix";
import ts from "typescript";
import type { CheckOptions } from "./check.ts";
import type { Path, Span } from "./type.ts";

const ROOT_MODULE_ALIAS = "__jtc_module";
const ROOT_TYPE_ALIAS = "__JtcRootType";

export interface TypeDefinition {
  filePath: string;
  targetSpan: Span;
  targetSelectionSpan: Span;
}

export function findDefinition(
  path: Path,
  typePath: string,
  baseFilePathOrOptions?: string | CheckOptions,
): TypeDefinition | null {
  const options = toCheckOptions(baseFilePathOrOptions);
  const baseFilePath = options.baseFilePath;
  const { modulePath, typeName } = parseTypePath(typePath);
  const entryFile = resolveVirtualEntryPath(baseFilePath);
  const entryDir = dirname(entryFile);
  const moduleSpecifier = resolveModuleSpecifier(modulePath, entryDir);
  const sourceText = buildDefinitionSource(moduleSpecifier, typeName);
  const compilerOptions = resolveCompilerOptions(options);
  const fs = options.fs;
  const preferFsOnly = options.preferFileSystemOnly === true && fs != null;

  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const readSource = (fileName: string): string | undefined => {
    if (fileName === entryFile) return sourceText;
    const text = fs?.readFile(fileName);
    if (text != null) return text;
    if (preferFsOnly) return undefined;
    return baseHost.readFile(fileName);
  };

  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists(fileName) {
      if (fileName === entryFile) return true;
      if (fs?.fileExists(fileName)) return true;
      if (preferFsOnly) return false;
      return baseHost.fileExists(fileName);
    },
    readFile(fileName) {
      return readSource(fileName);
    },
    getSourceFile(fileName, languageVersion) {
      const text = readSource(fileName);
      if (text == null) return undefined;
      return ts.createSourceFile(fileName, text, languageVersion, true);
    },
  };

  const program = ts.createProgram([entryFile], compilerOptions, host);
  const sourceFile = program.getSourceFile(entryFile);
  if (!sourceFile) return null;

  const checker = program.getTypeChecker();
  const valueDeclaration = findValueDeclarationInFile(sourceFile);
  const rootTypeNode = valueDeclaration?.type;
  if (!rootTypeNode) return null;

  if (path.length === 1 && path[0] === "$type") {
    return findRootTypeDefinition(sourceFile, checker);
  }

  let currentTypes = dedupeTypes([checker.getTypeFromTypeNode(rootTypeNode)]);
  let lastSymbols: ts.Symbol[] = [];

  for (const item of path) {
    if (typeof item === "number") {
      const nextTypes = dedupeTypes(
        currentTypes.flatMap((type) =>
          resolveIndexedTypes(checker, type, item)
        ),
      );
      if (nextTypes.length === 0) {
        return null;
      }
      currentTypes = nextTypes;
      continue;
    }

    const matches = currentTypes.flatMap((type) =>
      resolvePropertyMatches(checker, type, item)
    );
    if (matches.length === 0) {
      return null;
    }

    lastSymbols = dedupeSymbols(matches.map((item) => item.symbol));
    currentTypes = dedupeTypes(matches.map((item) => item.type));
  }

  return symbolsToDefinition(lastSymbols);
}

function toCheckOptions(
  baseFilePathOrOptions?: string | CheckOptions,
): CheckOptions {
  if (typeof baseFilePathOrOptions === "string") {
    return { baseFilePath: baseFilePathOrOptions };
  }
  return baseFilePathOrOptions ?? {};
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
  const baseDir = normalizedBasePath ? dirname(normalizedBasePath) : Deno.cwd();
  return toPosixPath(join(baseDir, "__jtc_definition__.ts"));
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

function buildDefinitionSource(modulePath: string, typeName: string): string {
  return [
    `import type * as ${ROOT_MODULE_ALIAS} from ${JSON.stringify(modulePath)};`,
    `type ${ROOT_TYPE_ALIAS} = ${ROOT_MODULE_ALIAS}.${typeName};`,
    "",
    `declare const value: ${ROOT_TYPE_ALIAS};`,
    "void value;",
    "",
  ].join("\n");
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

  const tsconfigPath = findNearestTsconfigPath(
    options.baseFilePath,
    options.fs,
  );
  if (!tsconfigPath) return defaults;

  const read = options.fs?.readFile ??
    ((path: string) => ts.sys.readFile(path));
  const configResult = ts.readConfigFile(tsconfigPath, read);
  if (configResult.error) return defaults;

  const configHost = options.fs
    ? {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: ts.sys.readDirectory,
      fileExists: options.fs.fileExists,
      readFile: options.fs.readFile,
    }
    : ts.sys;

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
  fs?: CheckOptions["fs"],
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

function resolvePropertyMatches(
  checker: ts.TypeChecker,
  type: ts.Type,
  name: string,
): Array<{ symbol: ts.Symbol; type: ts.Type }> {
  const matches: Array<{ symbol: ts.Symbol; type: ts.Type }> = [];

  for (const candidate of flattenTypes(type)) {
    const apparent = checker.getApparentType(candidate);
    const symbol = checker.getPropertyOfType(apparent, name);
    if (!symbol) continue;

    const anchor = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!anchor) continue;

    matches.push({
      symbol,
      type: checker.getTypeOfSymbolAtLocation(symbol, anchor),
    });
  }

  return matches;
}

function resolveIndexedTypes(
  checker: ts.TypeChecker,
  type: ts.Type,
  index: number,
): ts.Type[] {
  const results: ts.Type[] = [];

  for (const candidate of flattenTypes(type)) {
    const apparent = checker.getApparentType(candidate);

    if (checker.isTupleType(apparent)) {
      const typeArguments = checker.getTypeArguments(
        apparent as ts.TypeReference,
      );
      if (index < typeArguments.length) {
        results.push(typeArguments[index]);
        continue;
      }
    }

    const indexed = checker.getIndexTypeOfType(apparent, ts.IndexKind.Number) ??
      checker.getIndexTypeOfType(candidate, ts.IndexKind.Number);
    if (indexed) {
      results.push(indexed);
    }
  }

  return results;
}

function flattenTypes(type: ts.Type): ts.Type[] {
  if (type.isUnion()) {
    return type.types.flatMap((item) => flattenTypes(item));
  }
  if (type.isIntersection()) {
    return type.types.flatMap((item) => flattenTypes(item));
  }
  return [type];
}

function dedupeTypes(types: ts.Type[]): ts.Type[] {
  return Array.from(new Set(types));
}

function dedupeSymbols(symbols: ts.Symbol[]): ts.Symbol[] {
  const unique = new Map<string, ts.Symbol>();
  for (const symbol of symbols) {
    unique.set(symbolKey(symbol), symbol);
  }
  return Array.from(unique.values());
}

function symbolKey(symbol: ts.Symbol): string {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return symbol.getName();
  return `${declaration.getSourceFile().fileName}:${declaration.getStart()}:${symbol.getName()}`;
}

function symbolsToDefinition(
  symbols: readonly ts.Symbol[],
): TypeDefinition | null {
  for (const symbol of symbols) {
    const definition = symbolToDefinition(symbol);
    if (definition) return definition;
  }
  return null;
}

function symbolToDefinition(symbol: ts.Symbol): TypeDefinition | null {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return null;

  const selectionNode = getSelectionNode(declaration);
  return {
    filePath: declaration.getSourceFile().fileName,
    targetSpan: nodeToSpan(declaration),
    targetSelectionSpan: nodeToSpan(selectionNode ?? declaration),
  };
}

function getSelectionNode(declaration: ts.Declaration): ts.Node | undefined {
  if ("name" in declaration) {
    const named = declaration as ts.NamedDeclaration;
    if (named.name) return named.name;
  }
  return undefined;
}

function nodeToSpan(node: ts.Node): Span {
  const sourceFile = node.getSourceFile();
  return {
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  };
}

function findRootTypeDefinition(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): TypeDefinition | null {
  const aliasDeclaration = findTypeAliasDeclarationInFile(
    sourceFile,
    ROOT_TYPE_ALIAS,
  );
  if (!aliasDeclaration || !ts.isTypeReferenceNode(aliasDeclaration.type)) {
    return null;
  }

  const rootName = getRightmostEntityName(aliasDeclaration.type.typeName);
  const symbol = checker.getSymbolAtLocation(rootName);
  if (!symbol) return null;

  return symbolToDefinition(symbol);
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
    node.type != null;
}

function findTypeAliasDeclarationInFile(
  file: ts.SourceFile,
  name: string,
): ts.TypeAliasDeclaration | undefined {
  let found: ts.TypeAliasDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return found;
}

function getRightmostEntityName(name: ts.EntityName): ts.Identifier {
  if (ts.isIdentifier(name)) return name;
  return getRightmostEntityName(name.right);
}

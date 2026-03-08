import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createProtocolConnection,
  DefinitionRequest,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  type LocationLink,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node.js";

const CLI_ROOT = join(import.meta.dirname ?? Deno.cwd(), "..");
const FIXTURES_DIR = join(import.meta.dirname ?? Deno.cwd(), "fixtures");

Deno.test("jtc lsp handles initialize and shutdown handshake", async () => {
  const client = await startLspClient();
  try {
    const code = await stopLspClient(client);
    assertEquals(code, 0);
  } finally {
    client.connection.dispose();
  }
});

Deno.test("jtc lsp resolves definitions for json fields", async () => {
  const client = await startLspClient();
  try {
    const filePath = join(FIXTURES_DIR, "valid.json");
    const uri = toFileUrl(filePath).href;
    const text = await Deno.readTextFile(filePath);

    client.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri,
        languageId: "json",
        version: 1,
        text,
      },
    });

    const fieldDefinition = await client.connection.sendRequest(
      DefinitionRequest.type,
      {
        textDocument: { uri },
        position: { line: 2, character: 3 },
      },
    );

    assert(Array.isArray(fieldDefinition));
    assertEquals(fieldDefinition.length, 1);
    assert(isLocationLink(fieldDefinition[0]));
    if (!isLocationLink(fieldDefinition[0])) {
      throw new Error("expected LocationLink response");
    }
    assertEquals(
      fieldDefinition[0].targetUri,
      toFileUrl(join(FIXTURES_DIR, "types.ts")).href,
    );
    assertEquals(fieldDefinition[0].targetSelectionRange.start.line, 1);
    assertEquals(fieldDefinition[0].targetSelectionRange.start.character, 2);

    const typeKeyDefinition = await client.connection.sendRequest(
      DefinitionRequest.type,
      {
        textDocument: { uri },
        position: { line: 1, character: 3 },
      },
    );

    assert(Array.isArray(typeKeyDefinition));
    assertEquals(typeKeyDefinition.length, 1);
    assert(isLocationLink(typeKeyDefinition[0]));
    if (!isLocationLink(typeKeyDefinition[0])) {
      throw new Error("expected LocationLink response");
    }
    assertEquals(typeKeyDefinition[0].targetSelectionRange.start.line, 0);
    assertEquals(typeKeyDefinition[0].targetSelectionRange.start.character, 17);

    const typeValueDefinition = await client.connection.sendRequest(
      DefinitionRequest.type,
      {
        textDocument: { uri },
        position: { line: 1, character: 14 },
      },
    );

    assert(Array.isArray(typeValueDefinition));
    assertEquals(typeValueDefinition.length, 1);
    assert(isLocationLink(typeValueDefinition[0]));
    if (!isLocationLink(typeValueDefinition[0])) {
      throw new Error("expected LocationLink response");
    }
    assertEquals(typeValueDefinition[0].targetSelectionRange.start.line, 0);
    assertEquals(
      typeValueDefinition[0].targetSelectionRange.start.character,
      17,
    );
  } finally {
    const code = await stopLspClient(client);
    assertEquals(code, 0);
  }
});

Deno.test("jtc lsp publishes diagnostics for invalid json document", async () => {
  const client = await startLspClient();
  try {
    const filePath = join(FIXTURES_DIR, "invalid.json");
    const uri = toFileUrl(filePath).href;
    const text = await Deno.readTextFile(filePath);
    const diagnosticsPromise = waitForDiagnostics(client.connection, uri);

    client.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri,
        languageId: "json",
        version: 1,
        text,
      },
    });

    const published = await diagnosticsPromise;
    assertEquals(published.uri, uri);
    assert(published.diagnostics.length > 0);
    assertEquals(published.diagnostics[0].code, 2322);
  } finally {
    const code = await stopLspClient(client);
    assertEquals(code, 0);
  }
});

async function startLspClient(): Promise<{
  child: ReturnType<typeof spawn>;
  connection: ReturnType<typeof createProtocolConnection>;
}> {
  const child = spawn(Deno.execPath(), [
    "run",
    "--allow-read",
    "--allow-env",
    "src/main.ts",
    "lsp",
  ], {
    cwd: CLI_ROOT,
    stdio: ["pipe", "pipe", "ignore"],
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to start LSP subprocess with piped stdio");
  }

  const connection = createProtocolConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();

  await connection.sendRequest(InitializeRequest.type, {
    processId: null,
    clientInfo: { name: "jtc-cli-test", version: "0.0.0" },
    rootUri: null,
    capabilities: {},
    workspaceFolders: null,
  });
  connection.sendNotification(InitializedNotification.type, {});

  return { child, connection };
}

async function stopLspClient(
  client: {
    child: ReturnType<typeof spawn>;
    connection: ReturnType<typeof createProtocolConnection>;
  },
): Promise<number> {
  try {
    await client.connection.sendRequest(ShutdownRequest.type);
  } catch {
    // ignore shutdown errors while stopping
  }
  client.connection.sendNotification(ExitNotification.type);
  client.connection.dispose();
  const [code] = await once(client.child, "exit") as [
    number | null,
    NodeJS.Signals | null,
  ];
  return code ?? 1;
}

function waitForDiagnostics(
  connection: ReturnType<typeof createProtocolConnection>,
  uri: string,
): Promise<{ uri: string; diagnostics: Array<{ code?: number | string }> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for diagnostics: ${uri}`));
    }, 5000);

    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      if (params.uri !== uri) return;
      clearTimeout(timer);
      resolve(params);
    });
  });
}

function isLocationLink(value: unknown): value is LocationLink {
  if (!value || typeof value !== "object") return false;
  return "targetUri" in value && "targetSelectionRange" in value;
}

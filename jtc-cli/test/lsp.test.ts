import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createProtocolConnection,
  ExitNotification,
  InitializeRequest,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node.js";

const CLI_ROOT = join(import.meta.dirname ?? Deno.cwd(), "..");

Deno.test("jtc lsp handles initialize and shutdown handshake", async () => {
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

  const initializeResult = await connection.sendRequest(InitializeRequest.type, {
    processId: null,
    clientInfo: { name: "jtc-cli-test", version: "0.0.0" },
    rootUri: null,
    capabilities: {},
    workspaceFolders: null,
  });

  assertEquals(Boolean(initializeResult.capabilities), true);

  const shutdownResult = await connection.sendRequest(ShutdownRequest.type);
  assertEquals(shutdownResult, null);

  connection.sendNotification(ExitNotification.type);
  connection.dispose();
  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

  assertEquals(code ?? 1, 0);
});

import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import process from "node:process";

export function runLsp(): void {
  const connection = createConnection(
    ProposedFeatures.all,
    process.stdin,
    process.stdout,
  );
  let shutdownRequested = false;

  connection.onInitialize(() => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
      },
      serverInfo: {
        name: "jtc",
      },
    };
  });

  connection.onShutdown(() => {
    shutdownRequested = true;
  });

  connection.onNotification("exit", () => {
    Deno.exit(shutdownRequested ? 0 : 1);
  });

  connection.listen();
}

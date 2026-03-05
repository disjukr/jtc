import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

const CLI_ROOT = join(import.meta.dirname ?? Deno.cwd(), "..");
const FIXTURES_DIR = join(import.meta.dirname ?? Deno.cwd(), "fixtures");

Deno.test("jtc check exits with 0 for valid document", async () => {
  const result = await runCheck(join(FIXTURES_DIR, "valid.json"));
  assertEquals(result.code, 0);
});

Deno.test("jtc check exits with 1 and reports diagnostics for invalid document", async () => {
  const result = await runCheck(join(FIXTURES_DIR, "invalid.json"));
  const stderr = new TextDecoder().decode(result.stderr);

  assertEquals(result.code, 1);
  assertStringIncludes(stderr, "TS2322");
  assertStringIncludes(stderr, "$.age");
});

Deno.test("jtc check prints a user-facing error for malformed json", async () => {
  const result = await runCheck(join(FIXTURES_DIR, "invalid-syntax.json"));
  const stderr = new TextDecoder().decode(result.stderr);

  assertEquals(result.code, 1);
  assertStringIncludes(stderr, "jtc:");
  assertStringIncludes(stderr, "at 52");
});

async function runCheck(filePath: string): Promise<Deno.CommandOutput> {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: CLI_ROOT,
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      "src/main.ts",
      "check",
      filePath,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  return await command.output();
}

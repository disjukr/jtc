import { fromFileUrl, join } from "@std/path";

await emptyDir("./dist");
const denoBundleCommand = new Deno.Command(Deno.execPath(), {
  stdout: "inherit",
  stderr: "inherit",
  // deno-fmt-ignore
  args: [
    "bundle",
    "--format", "cjs",
    "--platform", "browser",
    "--external", "vscode",
    "--external", "typescript",
    "-o", "dist/main.js",
    "src/main.ts",
  ],
});
const status = await denoBundleCommand.output();
if (!status.success) {
  throw new Error("deno bundle failed");
}

async function emptyDir(dir: string | URL) {
  try {
    const items = await Array.fromAsync(Deno.readDir(dir));
    await Promise.all(items.map((item) => {
      if (item && item.name) {
        const filepath = join(toPathString(dir), item.name);
        return Deno.remove(filepath, { recursive: true });
      }
    }));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    await Deno.mkdir(dir, { recursive: true });
  }
}
function toPathString(pathUrl: string | URL): string {
  return pathUrl instanceof URL ? fromFileUrl(pathUrl) : pathUrl;
}

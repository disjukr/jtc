import { assertEquals } from "@std/assert";
import { parseDocumentContext } from "./document.ts";

Deno.test("parseDocumentContext resolves json field paths from cursor offsets", () => {
  const text = `{
  "user": {
    "aliases": [
      {
        "name": "Alice"
      }
    ]
  }
}`;
  const context = parseDocumentContext("json", text);

  assertEquals(context.offsetToPath(text.indexOf('"user"') + 1), ["user"]);
  assertEquals(context.offsetToPath(text.indexOf('"aliases"') + 1), [
    "user",
    "aliases",
  ]);
  assertEquals(context.offsetToPath(text.indexOf('"name"') + 1), [
    "user",
    "aliases",
    0,
    "name",
  ]);
});

Deno.test("parseDocumentContext resolves jsonc field paths from cursor offsets", () => {
  const text = `{
  // comment
  "user": {
    "name": "Alice"
  }
}`;
  const context = parseDocumentContext("jsonc", text);

  assertEquals(context.offsetToPath(text.indexOf('"name"') + 1), [
    "user",
    "name",
  ]);
});

Deno.test("parseDocumentContext resolves yaml field paths from cursor offsets", () => {
  const text = `user:
  addresses:
    - street: Main
`;
  const context = parseDocumentContext("yaml", text);

  assertEquals(context.offsetToPath(text.indexOf("user")), ["user"]);
  assertEquals(context.offsetToPath(text.indexOf("addresses")), [
    "user",
    "addresses",
  ]);
  assertEquals(context.offsetToPath(text.indexOf("street")), [
    "user",
    "addresses",
    0,
    "street",
  ]);
});

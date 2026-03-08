import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { findDefinition } from "./definition.ts";

Deno.test("findDefinition resolves top-level property members", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const typesPath = join(tempDir, "types.ts");
    const jsonPath = join(tempDir, "config.json");
    await Deno.writeTextFile(
      typesPath,
      `export interface User {
  name: string;
  age: number;
}
`,
    );
    await Deno.writeTextFile(jsonPath, "{}");

    const target = findDefinition(["name"], "./types.ts#User", {
      baseFilePath: jsonPath,
    });

    assert(target);
    if (!target) throw new Error("expected definition target");
    assertEquals(target.filePath, typesPath.replaceAll("\\", "/"));

    const source = await Deno.readTextFile(typesPath);
    assertEquals(
      source.slice(
        target.targetSelectionSpan.start,
        target.targetSelectionSpan.end,
      ),
      "name",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findDefinition resolves $type to the root type declaration", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const typesPath = join(tempDir, "types.ts");
    const jsonPath = join(tempDir, "config.json");
    await Deno.writeTextFile(
      typesPath,
      `export interface User {
  name: string;
  age: number;
}
`,
    );
    await Deno.writeTextFile(jsonPath, "{}");

    const target = findDefinition(["$type"], "./types.ts#User", {
      baseFilePath: jsonPath,
    });

    assert(target);
    if (!target) throw new Error("expected definition target");

    const source = await Deno.readTextFile(typesPath);
    assertEquals(
      source.slice(
        target.targetSelectionSpan.start,
        target.targetSelectionSpan.end,
      ),
      "User",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findDefinition returns null for unresolved nested path segments", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const typesPath = join(tempDir, "types.ts");
    const jsonPath = join(tempDir, "config.json");
    await Deno.writeTextFile(
      typesPath,
      `export interface Profile {
  name: string;
}

export interface User {
  profile: Profile;
}
`,
    );
    await Deno.writeTextFile(jsonPath, "{}");

    const target = findDefinition(["profile", "nickname"], "./types.ts#User", {
      baseFilePath: jsonPath,
    });

    assertEquals(target, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findDefinition resolves nested object members through array paths", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const typesPath = join(tempDir, "types.ts");
    const jsonPath = join(tempDir, "config.json");
    await Deno.writeTextFile(
      typesPath,
      `export interface Address {
  street: string;
}

export interface User {
  addresses: Address[];
}
`,
    );
    await Deno.writeTextFile(jsonPath, "{}");

    const target = findDefinition(
      ["addresses", 0, "street"],
      "./types.ts#User",
      {
        baseFilePath: jsonPath,
      },
    );

    assert(target);
    if (!target) throw new Error("expected definition target");

    const source = await Deno.readTextFile(typesPath);
    assertEquals(
      source.slice(
        target.targetSelectionSpan.start,
        target.targetSelectionSpan.end,
      ),
      "street",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

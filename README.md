![JTC Logo](./images/logo-with-text.png)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/disjukr.json-type-checker?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=disjukr.json-type-checker)
[![Open VSX](https://img.shields.io/open-vsx/v/disjukr/json-type-checker?label=Open%20VSX)](https://open-vsx.org/extension/disjukr/json-type-checker)

# JTC (JSON/YAML Type Checker)

JTC validates `json`, `jsonc`, and `yaml` documents against TypeScript types using a `$type` field.

## How It Works

1. Write `$type` in your document (example: `"./types.ts#MyType"`).
2. JTC parses the document into an internal rough JSON structure.
3. JTC runs TypeScript diagnostics for that value against the target type.
4. Diagnostics are shown directly in VS Code.

`$type` itself is treated as metadata and excluded from type checking.

## Example

![VSCode Demo](./images/vscode-demo.png)

```json
{
  "$type": "./types.ts#User",
  "name": "Alice",
  "age": 20
}
```

`./types.ts`

```ts
export interface User {
  name: string;
  age: number;
}
```

If a value has the wrong type, JTC reports a diagnostic at the corresponding JSON/YAML path.

## Monorepo Structure

- `json-type-checker`: core library (`@disjukr/jtc`)
- `jtc-vscode`: VS Code extension

## Development

Prerequisites:

- Deno
- VS Code (or compatible)

Build extension bundle:

```bash
cd jtc-vscode
deno task build
```

Watch mode:

```bash
cd jtc-vscode
deno task watch
```

Run extension dev host:

- Use the `Extension` launch configuration from `.vscode/launch.json`.

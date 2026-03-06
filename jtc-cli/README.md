# jtc-cli

`jtc-cli` is the command-line interface for JTC.

## Usage

Install global `jtc` command:

```bash
cd jtc-cli
deno task install-cli
```

Show help:

```bash
jtc --help
```

Type-check a document:

```bash
jtc check ./path/to/file.json
```

Run language server (stdio):

```bash
jtc lsp
```

## Development

Run from this repository without installing:

```bash
cd jtc-cli
deno task jtc --help
```

## Test

```bash
cd jtc-cli
deno task test
```

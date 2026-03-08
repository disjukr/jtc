import { type Node, parseTree } from "jsonc-parser";
import type { RoughJson } from "./rough-json.ts";
import type { Path, Span } from "./type.ts";

export function pathToSpan(node: Node, path: Path): Span {
  let current: Node | undefined = node;
  let currentSpan = getNodeSpan(node);

  for (const item of path) {
    const next = getChildNode(current, item);
    if (!next) break;
    current = next;
    currentSpan = getNodeSpan(current);
  }

  return currentSpan;
}

export function offsetToPath(node: Node, offset: number): Path | null {
  if (!containsOffset(node, offset)) return null;
  return findPathAtOffset(node, offset, []);
}

export function jsonTextToRoughJson(jsonText: string): RoughJson {
  const node = parseTree(jsonText);
  if (!node) return { type: "null" };
  return nodeToRoughJson(node, jsonText);
}

export function jsonNodeToRoughJson(node: Node, jsonText?: string): RoughJson {
  return nodeToRoughJson(node, jsonText);
}

function nodeToRoughJson(node: Node, jsonText?: string): RoughJson {
  switch (node.type) {
    case "null":
      return { type: "null" };
    case "boolean":
      return { type: "boolean", value: Boolean(node.value) };
    case "string":
      return { type: "string", value: String(node.value ?? "") };
    case "number":
      return {
        type: "number",
        text: getNumberText(node, jsonText),
      };
    case "array":
      return {
        type: "array",
        items: (node.children ?? []).map(
          (item) => nodeToRoughJson(item, jsonText),
        ),
      };
    case "object":
      return {
        type: "object",
        items: (node.children ?? [])
          .map((property) => propertyToKeyValue(property, jsonText))
          .filter((item) => item != null),
      };
    case "property": {
      const valueNode = node.children?.[1];
      if (!valueNode) return { type: "null" };
      return nodeToRoughJson(valueNode, jsonText);
    }
  }
}

function propertyToKeyValue(
  property: Node,
  jsonText?: string,
): { key: { type: "string"; value: string }; value: RoughJson } | undefined {
  if (property.type !== "property") return;
  const keyNode = property.children?.[0];
  const valueNode = property.children?.[1];
  if (!keyNode || !valueNode) return;
  return {
    key: { type: "string", value: String(keyNode.value ?? "") },
    value: nodeToRoughJson(valueNode, jsonText),
  };
}

function getChildNode(
  node: Node | undefined,
  pathItem: string | number,
): Node | undefined {
  if (!node) return;

  if (node.type === "object") {
    const key = String(pathItem);
    const property = (node.children ?? []).findLast((item) => {
      if (item.type !== "property") return false;
      return String(item.children?.[0]?.value ?? "") === key;
    });
    return property?.children?.[1];
  }

  if (node.type === "array") {
    if (typeof pathItem !== "number") return;
    if (!Number.isInteger(pathItem) || pathItem < 0) return;
    return node.children?.[pathItem];
  }
}

function findPathAtOffset(node: Node, offset: number, basePath: Path): Path {
  switch (node.type) {
    case "object": {
      for (const property of node.children ?? []) {
        if (property.type !== "property") continue;

        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        const key = String(keyNode?.value ?? "");
        const nextPath = [...basePath, key];

        if (keyNode && containsOffset(keyNode, offset)) {
          return nextPath;
        }

        if (valueNode && containsOffset(valueNode, offset)) {
          return findPathAtOffset(valueNode, offset, nextPath);
        }

        if (containsOffset(property, offset)) {
          return nextPath;
        }
      }

      return basePath;
    }
    case "array": {
      for (const [index, child] of (node.children ?? []).entries()) {
        if (!containsOffset(child, offset)) continue;
        return findPathAtOffset(child, offset, [...basePath, index]);
      }

      return basePath;
    }
    case "property": {
      const keyNode = node.children?.[0];
      const valueNode = node.children?.[1];
      const key = String(keyNode?.value ?? "");
      const nextPath = [...basePath, key];

      if (keyNode && containsOffset(keyNode, offset)) {
        return nextPath;
      }

      if (valueNode && containsOffset(valueNode, offset)) {
        return findPathAtOffset(valueNode, offset, nextPath);
      }

      return nextPath;
    }
    default:
      return basePath;
  }
}

function getNodeSpan(node: Node): Span {
  return { start: node.offset, end: node.offset + node.length };
}

function getNumberText(node: Node, jsonText?: string): string {
  if (jsonText) {
    const raw = jsonText.slice(node.offset, node.offset + node.length).trim();
    if (raw.length > 0) return raw;
  }
  return String(node.value);
}

function containsOffset(node: Node, offset: number): boolean {
  return offset >= node.offset && offset < node.offset + node.length;
}

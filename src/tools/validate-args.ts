/**
 * Minimal JSON-Schema argument validation for `tools/call`.
 *
 * WHY: the low-level MCP `Server` does NOT validate a tool call's arguments
 * against the tool's advertised `inputSchema` — it hands `params.arguments`
 * straight to the handler. Every `required` array we publish was therefore
 * advisory only, and the failure mode was ugly: `add_notebook` accepted a call
 * with no `description`/`topics` and wrote a half-empty entry to the library,
 * while `get_studio_output_status` read `args.output_type` before its own
 * try/catch and surfaced a raw `TypeError` (bypassing the isError /
 * structuredContent handling that its declared `outputSchema` requires).
 *
 * This validator covers exactly the JSON-Schema subset these tool definitions
 * use — `type: "object"` with flat `properties`, `required`, `enum`, and
 * nested `properties`/`items` one level down for `browser_options`. It is
 * deliberately permissive about anything it does not understand: unknown
 * keywords and unknown properties pass. Its job is to turn a malformed call
 * into a clear, actionable message instead of an internal stack trace — not to
 * be a general-purpose JSON-Schema engine.
 */

import type { Tool } from "@modelcontextprotocol/server";

/** JSON-Schema fragment shape, narrowed to what we actually read. */
interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  enum?: unknown[];
  items?: SchemaNode;
}

/**
 * MCP carries the progress token and other protocol metadata in `_meta`
 * alongside the real arguments. It is never part of a tool's own schema, so it
 * must never be reported as an unexpected argument.
 */
const PROTOCOL_KEYS = new Set(["_meta"]);

function typeOfValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(value: unknown, expected: string | string[] | undefined): boolean {
  if (expected === undefined) return true;
  const actual = typeOfValue(value);
  const allowed = Array.isArray(expected) ? expected : [expected];
  return allowed.some((t) => {
    if (t === "integer") return actual === "number" && Number.isInteger(value as number);
    // JSON Schema's "number" accepts integers too; our "object" must not match
    // arrays or null (typeOfValue already separates those).
    return t === actual;
  });
}

function describe(expected: string | string[]): string {
  return Array.isArray(expected) ? expected.join(" | ") : expected;
}

/**
 * Validate one property value against its schema node. Returns an error
 * message, or null when the value is acceptable.
 */
function validateValue(path: string, value: unknown, schema: SchemaNode): string | null {
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    return `\`${path}\` must be of type ${describe(schema.type)} (received ${typeOfValue(value)})`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    const allowed = schema.enum.map((v) => JSON.stringify(v)).join(", ");
    return `\`${path}\` must be one of: ${allowed} (received ${JSON.stringify(value)})`;
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validateValue(`${path}[${i}]`, value[i], schema.items);
      if (err) return err;
    }
  }

  if (
    schema.properties &&
    typeOfValue(value) === "object" &&
    (schema.type === undefined || schema.type === "object")
  ) {
    const obj = value as Record<string, unknown>;
    const nested = validateObject(path, obj, schema);
    if (nested) return nested;
  }

  return null;
}

function validateObject(
  path: string,
  args: Record<string, unknown>,
  schema: SchemaNode
): string | null {
  for (const key of schema.required ?? []) {
    const present = Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined;
    if (!present) {
      return `missing required argument \`${path ? `${path}.` : ""}${key}\``;
    }
    if (args[key] === null) {
      return `required argument \`${path ? `${path}.` : ""}${key}\` must not be null`;
    }
  }

  for (const [key, raw] of Object.entries(args)) {
    if (PROTOCOL_KEYS.has(key)) continue;
    const propSchema = schema.properties?.[key];
    // Unknown properties are tolerated: a newer client may send a field this
    // build does not know about, and rejecting it would be worse than ignoring.
    if (!propSchema) continue;
    // An explicitly-undefined optional property is the same as absent.
    if (raw === undefined) continue;
    const err = validateValue(path ? `${path}.${key}` : key, raw, propSchema);
    if (err) return err;
  }

  return null;
}

/**
 * Validate a tool call's arguments against the tool's own `inputSchema`.
 * Returns a human-readable error message, or null when the call is acceptable.
 */
export function validateToolArgs(
  tool: Tool,
  args: Record<string, unknown> | undefined
): string | null {
  const schema = tool.inputSchema as unknown as SchemaNode | undefined;
  if (!schema || schema.type !== "object") return null;

  const hasRequired = (schema.required?.length ?? 0) > 0;
  if (args === undefined || args === null) {
    // A tool with no required arguments is legitimately callable with no
    // `arguments` key at all (the SDK omits it); one with required arguments
    // is not.
    return hasRequired
      ? `missing required argument \`${schema.required![0]}\` (no arguments were provided)`
      : null;
  }

  if (typeOfValue(args) !== "object") {
    return "`arguments` must be an object";
  }

  return validateObject("", args, schema);
}

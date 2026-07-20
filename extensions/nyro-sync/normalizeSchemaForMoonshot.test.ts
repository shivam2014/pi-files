import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Copy of MFJS_FORBIDDEN_KEYWORDS + normalizeSchemaForMoonshot from index.ts
// Isolated here for unit testing. Keep in sync with source.
// ---------------------------------------------------------------------------

const MFJS_FORBIDDEN_KEYWORDS = new Set([
  "const", "oneOf", "allOf", "nullable", "prefixItems",
  "minItems", "maxItems", "minLength", "maxLength", "pattern",
  "format", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "uniqueItems", "title", "$schema",
  "$comment", "default", "examples",
]);

function normalizeSchemaForMoonshot(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeSchemaForMoonshot);

  const out: any = {};

  for (const [key, value] of Object.entries(schema)) {
    // Strip forbidden keywords
    if (MFJS_FORBIDDEN_KEYWORDS.has(key)) continue;

    // Recurse into known container keywords
    if (key === "properties" && typeof value === "object" && value !== null) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalizeSchemaForMoonshot(v)])
      );
      continue;
    }
    if ((key === "items" || key === "additionalProperties") && typeof value === "object") {
      out[key] = normalizeSchemaForMoonshot(value);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map(normalizeSchemaForMoonshot);
      continue;
    }

    out[key] = value;
  }

  // Fix: anyOf/oneOf with parent type → move type into each branch
  if (out.type && (out.anyOf || out.oneOf)) {
    const combinerKey = out.anyOf ? "anyOf" : "oneOf";
    const parentType = out.type;
    delete out.type;
    for (const branch of out[combinerKey]) {
      if (!branch.type) branch.type = parentType;
    }
  }

  // Strip $ref siblings (description after $ref causes conflicts)
  if (out.$ref) {
    delete out.description;
    delete out.title;
  }

  // Infer missing type from enum/const values
  if (!out.type && out.enum && Array.isArray(out.enum) && out.enum.length > 0) {
    const first = out.enum[0];
    if (typeof first === "string") out.type = "string";
    else if (typeof first === "number") out.type = "number";
    else if (typeof first === "boolean") out.type = "boolean";
    else if (Array.isArray(first)) out.type = "array";
    else if (typeof first === "object") out.type = "object";
  }

  // Collapse const to enum
  if (out.const !== undefined) {
    out.enum = [out.const];
    delete out.const;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("normalizeSchemaForMoonshot", () => {
  it("strips all forbidden keywords", () => {
    const input = {
      type: "object",
      const: "x",
      oneOf: [],
      allOf: [],
      nullable: true,
      prefixItems: [],
      minItems: 1,
      maxItems: 10,
      minLength: 1,
      maxLength: 100,
      pattern: ".*",
      format: "date-time",
      minimum: 0,
      maximum: 100,
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
      multipleOf: 5,
      uniqueItems: true,
      title: "Foo",
      $schema: "http://json-schema.org/draft-07/schema#",
      $comment: "ignore me",
      default: "bar",
      examples: ["a", "b"],
      description: "kept",
    };
    const result = normalizeSchemaForMoonshot(input);
    assert.deepStrictEqual(Object.keys(result).sort(), ["description", "type"]);
    assert.equal(result.type, "object");
    assert.equal(result.description, "kept");
  });

  it("flattens anyOf with parent type into each branch", () => {
    const input = {
      type: "object",
      anyOf: [
        { properties: { path: { type: "string" } } },
        { properties: {} },
      ],
    };
    const result = normalizeSchemaForMoonshot(input);
    assert.deepStrictEqual(result, {
      anyOf: [
        { type: "object", properties: { path: { type: "string" } } },
        { type: "object", properties: {} },
      ],
    });
    // type must NOT remain at top level
    assert.equal(result.type, undefined);
  });

  it("flattens oneOf with parent type into each branch", () => {
    const input = {
      type: "object",
      oneOf: [
        { properties: { a: { type: "string" } } },
        { properties: { b: { type: "number" } } },
      ],
    };
    const result = normalizeSchemaForMoonshot(input);
    assert.deepStrictEqual(result, {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    });
    assert.equal(result.type, undefined);
  });

  it("does not flatten combiner when branches already have type", () => {
    const input = {
      type: "object",
      anyOf: [
        { type: "string", properties: {} },
        { type: "number" },
      ],
    };
    const result = normalizeSchemaForMoonshot(input);
    assert.deepStrictEqual(result, {
      anyOf: [
        { type: "string", properties: {} },
        { type: "number" },
      ],
    });
    assert.equal(result.type, undefined);
  });

  it("strips if/then/else conditional schemas", () => {
    const input = {
      type: "object",
      if: { properties: { kind: { const: "a" } } },
      then: { properties: { aField: { type: "string" } } },
      else: { properties: { bField: { type: "number" } } },
    };
    const result = normalizeSchemaForMoonshot(input);
    assert.deepStrictEqual(result, { type: "object" });
  });

  it("strips $ref siblings (description, title)", () => {
    const input = {
      $ref: "#/$defs/Foo",
      description: "A foo object",
      title: "Foo Title",
    };
    const result = normalizeSchemaForMoonshot(input);
    assert.deepStrictEqual(result, { $ref: "#/$defs/Foo" });
  });

  it("infers missing type from enum values", () => {
    assert.deepStrictEqual(
      normalizeSchemaForMoonshot({ enum: ["a", "b", "c"] }),
      { type: "string", enum: ["a", "b", "c"] }
    );
    assert.deepStrictEqual(
      normalizeSchemaForMoonshot({ enum: [1, 2, 3] }),
      { type: "number", enum: [1, 2, 3] }
    );
    assert.deepStrictEqual(
      normalizeSchemaForMoonshot({ enum: [true, false] }),
      { type: "boolean", enum: [true, false] }
    );
  });

  it("collapses const to enum array", () => {
    assert.deepStrictEqual(
      normalizeSchemaForMoonshot({ const: "foo" }),
      { enum: ["foo"] }
    );
    assert.deepStrictEqual(
      normalizeSchemaForMoonshot({ const: 42 }),
      { enum: [42] }
    );
  });

  it("recurses into nested properties stripping forbidden keywords", () => {
    const input = {
      type: "object",
      properties: {
        a: { type: "string", pattern: ".*", minLength: 1 },
      },
    };
    const result = normalizeSchemaForMoonshot(input);
    assert.deepStrictEqual(result, {
      type: "object",
      properties: {
        a: { type: "string" },
      },
    });
  });

  it("recurses into array items stripping forbidden keywords", () => {
    const input = {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 100 },
    };
    const result = normalizeSchemaForMoonshot(input);
    assert.deepStrictEqual(result, {
      type: "array",
      items: { type: "string" },
    });
  });

  it("passes through null and undefined unchanged", () => {
    assert.equal(normalizeSchemaForMoonshot(null), null);
    assert.equal(normalizeSchemaForMoonshot(undefined), undefined);
  });

  it("returns empty object for empty schema", () => {
    assert.deepStrictEqual(normalizeSchemaForMoonshot({}), {});
  });

  it("handles complex real-world schema with multiple issues", () => {
    const input = {
      type: "object",
      title: "ToolParams",
      properties: {
        query: {
          type: "string",
          description: "Search query",
          minLength: 1,
          maxLength: 500,
          pattern: "^.+$",
        },
        count: {
          type: "number",
          minimum: 1,
          maximum: 100,
          default: 10,
        },
        filter: {
          type: "object",
          anyOf: [
            { properties: { tag: { type: "string", format: "date" } } },
            { properties: { id: { type: "number", minimum: 0 } } },
          ],
        },
        ref: {
          $ref: "#/$defs/Extra",
          description: "extra params",
          title: "Extra",
        },
        status: {
          enum: ["active", "inactive"],
          title: "Status",
        },
        kind: {
          const: "special",
        },
      },
      if: { properties: { mode: { const: "advanced" } } },
      then: { required: ["count"] },
    };

    const result = normalizeSchemaForMoonshot(input);

    // title stripped from top level
    assert.equal(result.title, undefined);
    assert.equal(result.type, "object");

    // query: pattern, minLength, maxLength stripped
    assert.deepStrictEqual(result.properties.query, {
      type: "string",
      description: "Search query",
    });

    // count: minimum, maximum, default stripped
    assert.deepStrictEqual(result.properties.count, {
      type: "number",
    });

    // filter.anyOf branches get parent type "object", format/minimum stripped
    assert.deepStrictEqual(result.properties.filter, {
      type: "object",
      anyOf: [
        { type: "object", properties: { tag: { type: "string" } } },
        { type: "object", properties: { id: { type: "number" } } },
      ],
    });

    // $ref siblings stripped
    assert.deepStrictEqual(result.properties.ref, {
      $ref: "#/$defs/Extra",
    });

    // enum: title stripped, type inferred
    assert.deepStrictEqual(result.properties.status, {
      type: "string",
      enum: ["active", "inactive"],
    });

    // const collapsed to enum
    assert.deepStrictEqual(result.properties.kind, {
      enum: ["special"],
    });

    // if/then/else removed
    assert.equal(result.if, undefined);
    assert.equal(result.then, undefined);
    assert.equal(result.else, undefined);
  });
});

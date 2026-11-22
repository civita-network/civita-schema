// Validation module for the CIVITA Geometry Library.
//
// Three validation layers are provided:
//   1. validateLibraryStructure  - JSON Schema (Draft 2020-12) validation of
//      geometry_library.json against geometry_library.schema.json. Requires a
//      standards-compliant validator (Ajv); see loadAjv.
//   2. validateLibrarySemantics  - internal consistency checks that JSON Schema
//      cannot express (identity, uniqueness, bounds, defaults, expressions,
//      profile conventions) plus checkFigureReferences for figure files.
//   3. validateGeometryInstance  - validation of one geometry instance against
//      the resolved library definition.
//
// Only Node.js standard modules are used. Expressions are parsed by a small
// recursive-descent parser; nothing is evaluated with eval() or Function().

import { readFileSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const GEOMETRY_TYPE_ID_PATTERN = /^GLOB-GEO[0-9]{4}$/;
const COMPARISON_OPERATORS = new Set([">", ">=", "<"]);
const BOUND_KEYS = ["minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum"];

// ---------------------------------------------------------------------------
// Expression grammar
//
//   expression := term (("+" | "-") term)*
//   term       := factor (("*" | "/") factor)*
//   factor     := NUMBER | IDENTIFIER | "(" expression ")"
//   NUMBER     := [0-9]+ ("." [0-9]+)?
//   IDENTIFIER := [A-Za-z_][A-Za-z0-9_]*
//
// Operators of equal precedence associate left to right. Unary operators,
// exponents, function calls, and any other syntax are rejected.
// ---------------------------------------------------------------------------

export class ExpressionError extends Error {
  constructor(message, expression, position) {
    super(position === undefined ? message : `${message} at position ${position}`);
    this.name = "ExpressionError";
    this.expression = expression;
    this.position = position;
  }
}

function tokenize(source) {
  if (typeof source !== "string") throw new ExpressionError("expression must be a string", source);
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " ") { i += 1; continue; }
    const rest = source.slice(i);
    let m;
    if ((m = /^[0-9]+(\.[0-9]+)?/.exec(rest))) {
      if (/^[0-9.A-Za-z_]/.test(rest.slice(m[0].length))) {
        throw new ExpressionError(`malformed number "${rest.match(/^[0-9.A-Za-z_]+/)[0]}"`, source, i);
      }
      tokens.push({ kind: "number", text: m[0], value: Number(m[0]), position: i });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      tokens.push({ kind: "identifier", text: m[0], position: i });
      i += m[0].length;
    } else if ("+-*/()".includes(ch)) {
      tokens.push({ kind: ch, text: ch, position: i });
      i += 1;
    } else {
      throw new ExpressionError(`unsupported character "${ch}"`, source, i);
    }
  }
  if (tokens.length === 0) throw new ExpressionError("empty expression", source);
  return tokens;
}

/** Parse an expression into an abstract syntax tree. Throws ExpressionError. */
export function parseExpression(source) {
  const tokens = tokenize(source);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];

  function parseFactor() {
    const token = next();
    if (!token) throw new ExpressionError("unexpected end of expression", source);
    if (token.kind === "number") {
      if (!Number.isFinite(token.value)) throw new ExpressionError(`nonfinite literal "${token.text}"`, source, token.position);
      return { type: "number", value: token.value };
    }
    if (token.kind === "identifier") {
      if (peek()?.kind === "(") {
        throw new ExpressionError(`function call "${token.text}(...)" is not permitted`, source, token.position);
      }
      return { type: "identifier", name: token.text, position: token.position };
    }
    if (token.kind === "(") {
      const inner = parseSum();
      const closing = next();
      if (!closing || closing.kind !== ")") throw new ExpressionError("missing closing parenthesis", source, token.position);
      return inner;
    }
    if (token.kind === "+" || token.kind === "-") {
      throw new ExpressionError(`unary "${token.kind}" is not permitted`, source, token.position);
    }
    throw new ExpressionError(`unexpected "${token.text}"`, source, token.position);
  }

  function parseProduct() {
    let node = parseFactor();
    while (peek() && (peek().kind === "*" || peek().kind === "/")) {
      const op = next().kind;
      node = { type: "binary", operator: op, left: node, right: parseFactor() };
    }
    return node;
  }

  function parseSum() {
    let node = parseProduct();
    while (peek() && (peek().kind === "+" || peek().kind === "-")) {
      const op = next().kind;
      node = { type: "binary", operator: op, left: node, right: parseProduct() };
    }
    return node;
  }

  const tree = parseSum();
  if (index < tokens.length) {
    const token = tokens[index];
    throw new ExpressionError(token.kind === ")" ? "unmatched closing parenthesis" : `unexpected "${token.text}"`, source, token.position);
  }
  return tree;
}

/** Identifiers referenced by a parsed expression, in order of first use. */
export function expressionIdentifiers(tree) {
  const names = [];
  (function visit(node) {
    if (node.type === "identifier") { if (!names.includes(node.name)) names.push(node.name); }
    else if (node.type === "binary") { visit(node.left); visit(node.right); }
  })(tree);
  return names;
}

/** Evaluate a parsed expression with numerical values. Throws ExpressionError. */
export function evaluateExpression(tree, values, source = "") {
  const result = (function evaluate(node) {
    if (node.type === "number") return node.value;
    if (node.type === "identifier") {
      const value = values[node.name];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ExpressionError(`identifier "${node.name}" has no finite numerical value`, source);
      }
      return value;
    }
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    switch (node.operator) {
      case "+": return left + right;
      case "-": return left - right;
      case "*": return left * right;
      case "/":
        if (right === 0) throw new ExpressionError("division by zero", source);
        return left / right;
      default: throw new ExpressionError(`unsupported operator "${node.operator}"`, source);
    }
  })(tree);
  if (!Number.isFinite(result)) throw new ExpressionError("nonfinite result", source);
  return result;
}

/** True if the subtree contains no identifiers. */
function isConstant(node) {
  return node.type === "number" || (node.type === "binary" && isConstant(node.left) && isConstant(node.right));
}

/** Detect division by a constant subexpression equal to zero. */
function findConstantZeroDivision(node) {
  if (node.type !== "binary") return false;
  if (node.operator === "/" && isConstant(node.right)) {
    try { if (evaluateExpression(node.right, {}) === 0) return true; } catch { return true; }
  }
  return findConstantZeroDivision(node.left) || findConstantZeroDivision(node.right);
}

export function compare(left, operator, right) {
  switch (operator) {
    case ">": return left > right;
    case ">=": return left >= right;
    case "<": return left < right;
    default: throw new Error(`unsupported comparison operator "${operator}"`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function boundViolations(value, definition) {
  const violations = [];
  if ("minimum" in definition && !(value >= definition.minimum)) violations.push(`must be >= ${definition.minimum}`);
  if ("exclusiveMinimum" in definition && !(value > definition.exclusiveMinimum)) violations.push(`must be > ${definition.exclusiveMinimum}`);
  if ("maximum" in definition && !(value <= definition.maximum)) violations.push(`must be <= ${definition.maximum}`);
  if ("exclusiveMaximum" in definition && !(value < definition.exclusiveMaximum)) violations.push(`must be < ${definition.exclusiveMaximum}`);
  return violations;
}

/** Check that declared bounds admit at least one value. */
function boundsAreConsistent(definition) {
  const lower = "exclusiveMinimum" in definition
    ? { value: definition.exclusiveMinimum, strict: true }
    : "minimum" in definition ? { value: definition.minimum, strict: false } : null;
  const upper = "exclusiveMaximum" in definition
    ? { value: definition.exclusiveMaximum, strict: true }
    : "maximum" in definition ? { value: definition.maximum, strict: false } : null;
  const messages = [];
  if ("minimum" in definition && "exclusiveMinimum" in definition) messages.push("declares both minimum and exclusiveMinimum");
  if ("maximum" in definition && "exclusiveMaximum" in definition) messages.push("declares both maximum and exclusiveMaximum");
  for (const key of BOUND_KEYS) {
    if (key in definition && (typeof definition[key] !== "number" || !Number.isFinite(definition[key]))) {
      messages.push(`${key} must be a finite number`);
    }
  }
  if (lower && upper && Number.isFinite(lower.value) && Number.isFinite(upper.value)) {
    if (lower.value > upper.value || (lower.value === upper.value && (lower.strict || upper.strict))) {
      messages.push("lower bound exceeds upper bound; no value is admissible");
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Layer 1: structural validation with a standards-compliant validator
// ---------------------------------------------------------------------------

/**
 * Load Ajv (Draft 2020-12) and its required ajv-formats plugin.
 * Resolution order: normal module resolution from this repository, then the
 * directory named by the CIVITA_AJV_DIR environment variable (a directory that
 * contains, or is, a node_modules folder with ajv installed).
 * Returns { Ajv2020, addFormats, source } or { unavailable: reason }.
 */
export async function loadAjv(env = process.env) {
  const attempts = [];
  const candidates = [{ label: "civita-schema module resolution", base: path.join(REPOSITORY_ROOT, "package.json") }];
  if (env.CIVITA_AJV_DIR) {
    const dir = path.resolve(env.CIVITA_AJV_DIR);
    candidates.push({ label: `CIVITA_AJV_DIR=${dir}`, base: path.join(dir, "package.json") });
    candidates.push({ label: `CIVITA_AJV_DIR=${dir}`, base: path.join(dir, "..", "package.json") });
  }
  for (const { label, base } of candidates) {
    let dependency = "Ajv (Draft 2020-12)";
    try {
      const require = createRequire(base);
      const ajvPath = require.resolve("ajv/dist/2020.js");
      const ajvModule = await import(pathToFileURL(ajvPath).href);
      const Ajv2020 = ajvModule.default?.default ?? ajvModule.default ?? ajvModule.Ajv2020;
      if (typeof Ajv2020 !== "function") throw new Error("Draft 2020-12 constructor not exported");
      const version = JSON.parse(readFileSync(require.resolve("ajv/package.json"), "utf8")).version;
      dependency = "ajv-formats";
      const formatsModule = await import(pathToFileURL(require.resolve("ajv-formats")).href);
      const addFormats = formatsModule.default?.default ?? formatsModule.default;
      if (typeof addFormats !== "function") throw new Error("format plugin not exported");
      return { Ajv2020, addFormats, source: `${label} (ajv ${version}, ajv-formats)` };
    } catch (error) {
      attempts.push(`${label}: ${dependency}: ${error.code ?? error.message}`);
    }
  }
  return { unavailable: `Structural validation dependencies unavailable. Tried ${attempts.join("; ")}. Run npm ci to install Ajv and ajv-formats.` };
}

/** Compile the Geometry Library schema with Ajv. Validates the schema itself against the Draft 2020-12 meta-schema. */
export function compileLibrarySchema(ajvBundle, root = REPOSITORY_ROOT) {
  const { Ajv2020, addFormats } = ajvBundle;
  if (typeof addFormats !== "function") throw new Error("ajv-formats is required for structural validation");
  // allowMatchingProperties: named reference-system conventions (for example
  // notch_convention) intentionally also satisfy the *_convention pattern rule.
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowMatchingProperties: true, validateFormats: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: "metadata", schemaType: "object" }); // CIVITA annotation on schema documents
  const metadataSchema = JSON.parse(readFileSync(path.join(root, "metadata.schema.json"), "utf8"));
  const librarySchema = JSON.parse(readFileSync(path.join(root, "geometry_library.schema.json"), "utf8"));
  ajv.addSchema(metadataSchema);
  return { validate: ajv.compile(librarySchema), formatsValidated: true };
}

export function validateLibraryStructure(compiled, library) {
  const valid = compiled.validate(library);
  const errors = valid ? [] : compiled.validate.errors.map((e) => ({
    code: "schema",
    path: e.instancePath || "/",
    message: `${e.instancePath || "/"} ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""}`,
  }));
  return { valid, errors };
}

// ---------------------------------------------------------------------------
// Layer 2: semantic validation of the library
// ---------------------------------------------------------------------------

/**
 * Check internal consistency of a parsed geometry library. Does not require
 * the JSON Schema to have passed; malformed parts are reported and skipped.
 * Returns { valid, errors: [{ code, path, message }] }.
 */
export function validateLibrarySemantics(library) {
  const errors = [];
  const add = (code, where, message) => errors.push({ code, path: where, message: `${where}: ${message}` });

  if (!isPlainObject(library)) {
    add("library_type", "/", "library must be a JSON object");
    return { valid: false, errors };
  }
  if (library.metadata?.version !== undefined && library.version !== library.metadata.version) {
    add("version_mismatch", "/version", `root version "${library.version}" differs from metadata.version "${library.metadata.version}"`);
  }

  let declaredIdPattern = null;
  const patternText = library.global_conventions?.geometry_type_identifier_pattern;
  if (typeof patternText === "string") {
    try { declaredIdPattern = new RegExp(patternText, "u"); }
    catch { add("id_pattern", "/global_conventions/geometry_type_identifier_pattern", "is not a valid regular expression"); }
  }
  const coordinateType = library.global_conventions?.coordinate_system_type;

  if (!isPlainObject(library.geometries)) {
    add("geometries_type", "/geometries", "must be an object of geometry definitions");
    return { valid: false, errors };
  }

  const seenIds = new Map();
  const seenNames = new Map();
  for (const [key, geometry] of Object.entries(library.geometries)) {
    const where = `/geometries/${key}`;
    if (!isPlainObject(geometry)) { add("geometry_type", where, "definition must be an object"); continue; }

    // Identity
    if (geometry.name !== key) add("name_key_mismatch", `${where}/name`, `name "${geometry.name}" does not match its key "${key}"`);
    if (typeof geometry.name !== "string" || !IDENTIFIER_PATTERN.test(geometry.name)) add("name_format", `${where}/name`, "must be lowercase_with_underscores");
    if (typeof geometry.geometry_type_id !== "string" || !GEOMETRY_TYPE_ID_PATTERN.test(geometry.geometry_type_id)) {
      add("id_format", `${where}/geometry_type_id`, `"${geometry.geometry_type_id}" does not match ^GLOB-GEO[0-9]{4}$`);
    } else if (declaredIdPattern && !declaredIdPattern.test(geometry.geometry_type_id)) {
      add("id_format", `${where}/geometry_type_id`, "does not match global_conventions.geometry_type_identifier_pattern");
    }
    if (typeof geometry.version !== "string" || !SEMVER_PATTERN.test(geometry.version)) {
      add("version_format", `${where}/version`, `"${geometry.version}" is not MAJOR.MINOR.PATCH`);
    }
    if (seenIds.has(geometry.geometry_type_id)) add("duplicate_id", `${where}/geometry_type_id`, `"${geometry.geometry_type_id}" is also used by ${seenIds.get(geometry.geometry_type_id)}`);
    else seenIds.set(geometry.geometry_type_id, key);
    if (seenNames.has(geometry.name)) add("duplicate_name", `${where}/name`, `"${geometry.name}" is also used by ${seenNames.get(geometry.name)}`);
    else seenNames.set(geometry.name, key);
    if (coordinateType && geometry.reference_system?.type !== coordinateType) {
      add("coordinate_system", `${where}/reference_system/type`, `must equal global coordinate_system_type "${coordinateType}"`);
    }

    // Independent parameters
    const numerical = new Set();
    const categorical = new Set();
    const independent = new Set();
    if (!Array.isArray(geometry.parameters)) {
      add("parameters_type", `${where}/parameters`, "must be an array");
    } else {
      geometry.parameters.forEach((parameter, i) => {
        const pWhere = `${where}/parameters/${i}`;
        if (!isPlainObject(parameter)) { add("parameter_type", pWhere, "must be an object"); return; }
        const { name, type } = parameter;
        if (typeof name !== "string" || !IDENTIFIER_PATTERN.test(name)) add("parameter_name", `${pWhere}/name`, `"${name}" must be lowercase_with_underscores`);
        if (independent.has(name)) add("duplicate_parameter", `${pWhere}/name`, `duplicate independent parameter "${name}"`);
        independent.add(name);
        if (typeof parameter.required !== "boolean") add("parameter_required", `${pWhere}/required`, "must be a boolean");
        if (parameter.required === true && "default" in parameter) add("required_with_default", `${pWhere}/default`, `required parameter "${name}" must not declare a default`);

        if (type === "number") {
          numerical.add(name);
          if ("enum" in parameter) add("numeric_enum", `${pWhere}/enum`, `numerical parameter "${name}" must not declare enum`);
          for (const message of boundsAreConsistent(parameter)) add("bounds", pWhere, `parameter "${name}" ${message}`);
          if ("default" in parameter) {
            if (typeof parameter.default !== "number" || !Number.isFinite(parameter.default)) add("default_type", `${pWhere}/default`, `default of numerical parameter "${name}" must be a finite number`);
            else for (const message of boundViolations(parameter.default, parameter)) add("default_bounds", `${pWhere}/default`, `default ${parameter.default} ${message}`);
          }
        } else if (type === "string") {
          categorical.add(name);
          for (const key of [...BOUND_KEYS, "unit"]) if (key in parameter) add("categorical_numeric_keyword", `${pWhere}/${key}`, `categorical parameter "${name}" must not declare ${key}`);
          const values = parameter.enum;
          if (!Array.isArray(values) || values.length === 0) {
            add("enum_missing", `${pWhere}/enum`, `categorical parameter "${name}" must declare a nonempty enum`);
          } else {
            values.forEach((value, j) => {
              if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) add("enum_value", `${pWhere}/enum/${j}`, `enum value ${JSON.stringify(value)} must be a lowercase_with_underscores string`);
            });
            if (new Set(values).size !== values.length) add("enum_duplicate", `${pWhere}/enum`, "enum values must be unique");
          }
          if ("default" in parameter) {
            if (typeof parameter.default !== "string") add("default_type", `${pWhere}/default`, `default of categorical parameter "${name}" must be a string`);
            else if (Array.isArray(values) && !values.includes(parameter.default)) add("default_not_in_enum", `${pWhere}/default`, `default "${parameter.default}" is not one of ${JSON.stringify(values)}`);
          }
        } else {
          add("parameter_type_unsupported", `${pWhere}/type`, `parameter "${name}" has unsupported type ${JSON.stringify(type)}; expected "number" or "string"`);
        }
      });
    }

    const derivedNames = new Set();
    if ("derived_parameters" in geometry) {
      if (!Array.isArray(geometry.derived_parameters)) add("derived_type", `${where}/derived_parameters`, "must be an array");
      else for (const derived of geometry.derived_parameters) if (isPlainObject(derived)) derivedNames.add(derived.name);
    }

    const checkExpression = (expression, exprWhere, context) => {
      let tree;
      try { tree = parseExpression(expression); }
      catch (error) { add("expression_syntax", exprWhere, `${context} "${expression}": ${error.message}`); return null; }
      for (const identifier of expressionIdentifiers(tree)) {
        if (numerical.has(identifier)) continue;
        if (categorical.has(identifier)) add("expression_categorical_reference", exprWhere, `${context} "${expression}" references categorical parameter "${identifier}"; only numerical independent parameters are permitted`);
        else if (derivedNames.has(identifier)) add("expression_derived_reference", exprWhere, `${context} "${expression}" references derived parameter "${identifier}"; only numerical independent parameters are permitted`);
        else add("expression_unknown_identifier", exprWhere, `${context} "${expression}" references unknown identifier "${identifier}"`);
      }
      if (findConstantZeroDivision(tree)) add("expression_division_by_zero", exprWhere, `${context} "${expression}" divides by a constant zero`);
      return tree;
    };

    // Derived parameters
    const derivedSeen = new Set();
    (Array.isArray(geometry.derived_parameters) ? geometry.derived_parameters : []).forEach((derived, i) => {
      const dWhere = `${where}/derived_parameters/${i}`;
      if (!isPlainObject(derived)) { add("derived_type", dWhere, "must be an object"); return; }
      const { name } = derived;
      if (typeof name !== "string" || !IDENTIFIER_PATTERN.test(name)) add("parameter_name", `${dWhere}/name`, `"${name}" must be lowercase_with_underscores`);
      if (derivedSeen.has(name)) add("duplicate_derived", `${dWhere}/name`, `duplicate derived parameter "${name}"`);
      derivedSeen.add(name);
      if (independent.has(name)) add("derived_shadows_independent", `${dWhere}/name`, `derived parameter "${name}" duplicates an independent parameter name`);
      if (derived.type !== "number") add("derived_type_unsupported", `${dWhere}/type`, `derived parameter "${name}" must have type "number"`);
      for (const message of boundsAreConsistent(derived)) add("bounds", dWhere, `derived parameter "${name}" ${message}`);
      checkExpression(derived.expression, `${dWhere}/expression`, `derived parameter "${name}" expression`);
    });

    // Geometric constraints
    if ("geometric_constraints" in geometry && !Array.isArray(geometry.geometric_constraints)) {
      add("constraints_type", `${where}/geometric_constraints`, "must be an array");
    }
    (Array.isArray(geometry.geometric_constraints) ? geometry.geometric_constraints : []).forEach((constraint, i) => {
      const cWhere = `${where}/geometric_constraints/${i}`;
      if (!isPlainObject(constraint)) { add("constraint_type", cWhere, "must be an object"); return; }
      if (!COMPARISON_OPERATORS.has(constraint.operator)) add("constraint_operator", `${cWhere}/operator`, `unsupported operator ${JSON.stringify(constraint.operator)}; expected one of > >= <`);
      checkExpression(constraint.left, `${cWhere}/left`, "constraint left side");
      checkExpression(constraint.right, `${cWhere}/right`, "constraint right side");
    });

    // Structured profile convention
    const profile = geometry.reference_system?.profile_convention;
    if (isPlainObject(profile)) {
      const pcWhere = `${where}/reference_system/profile_convention`;
      const axes = typeof profile.plane === "string" ? profile.plane.split("-") : [];
      if (axes.length !== 2) {
        add("profile_plane", `${pcWhere}/plane`, `invalid plane ${JSON.stringify(profile.plane)}`);
      } else {
        const expectedKey = `vertices_${axes.join("")}`;
        for (const key of ["vertices_xy", "vertices_xz", "vertices_yz"]) {
          if (key in profile && key !== expectedKey) add("profile_vertices_plane", `${pcWhere}/${key}`, `does not match plane "${profile.plane}" (expected ${expectedKey})`);
        }
        if (!(expectedKey in profile)) add("profile_vertices_missing", pcWhere, `missing ${expectedKey} for plane "${profile.plane}"`);
        if (isPlainObject(profile.reentrant_corner)) {
          const keys = Object.keys(profile.reentrant_corner).sort();
          if (keys.join() !== [...axes].sort().join()) add("profile_corner_axes", `${pcWhere}/reentrant_corner`, `coordinates must be ${axes.join(" and ")}`);
        }
        const normal = ["x", "y", "z"].find((axis) => !axes.includes(axis));
        if (profile.extrusion?.axis !== normal) add("profile_extrusion_axis", `${pcWhere}/extrusion/axis`, `must be "${normal}", the normal to plane "${profile.plane}"`);
      }
      const coordinates = [];
      for (const key of ["vertices_xy", "vertices_xz", "vertices_yz"]) {
        if (Array.isArray(profile[key])) profile[key].forEach((vertex, i) => Array.isArray(vertex) && vertex.forEach((c, j) => coordinates.push([c, `${pcWhere}/${key}/${i}/${j}`])));
      }
      if (isPlainObject(profile.reentrant_corner)) for (const [axis, c] of Object.entries(profile.reentrant_corner)) coordinates.push([c, `${pcWhere}/reentrant_corner/${axis}`]);
      if (isPlainObject(profile.extrusion)) for (const key of ["from", "distance"]) coordinates.push([profile.extrusion[key], `${pcWhere}/extrusion/${key}`]);
      for (const [c, cWhere] of coordinates) {
        if (typeof c === "string") checkExpression(c, cWhere, "profile coordinate");
        else if (typeof c !== "number" || !Number.isFinite(c)) add("profile_coordinate", cWhere, "must be a finite number or an expression");
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Figure references
// ---------------------------------------------------------------------------

/**
 * Check the SVG, PDF, and TikZ files of every geometry and the shared style.
 * File locations follow tikz_implementation in geometry_figure_design_standard.json.
 */
export function checkFigureReferences(library, root = REPOSITORY_ROOT) {
  const errors = [];
  const checked = [];
  const add = (code, where, message) => errors.push({ code, path: where, message: `${where}: ${message}` });
  const standard = JSON.parse(readFileSync(path.join(root, "geometry_figure_design_standard.json"), "utf8"));
  const tikz = standard.tikz_implementation;
  const rootReal = realpathSync(root);

  const checkFile = (relative, where, label) => {
    if (typeof relative !== "string" || relative === "" || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..")) {
      add("figure_path_unsafe", where, `${label} path ${JSON.stringify(relative)} must be a repository-relative path without ".."`);
      return false;
    }
    const absolute = path.resolve(rootReal, relative);
    let real;
    try { real = realpathSync(absolute); }
    catch { add("figure_missing", where, `${label} ${relative} does not exist`); return false; }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      add("figure_path_unsafe", where, `${label} ${relative} resolves outside the repository`);
      return false;
    }
    const stats = statSync(real);
    if (!stats.isFile()) { add("figure_not_file", where, `${label} ${relative} is not a file`); return false; }
    if (stats.size === 0) { add("figure_empty", where, `${label} ${relative} is empty`); return false; }
    checked.push(relative);
    return true;
  };

  checkFile(tikz.shared_style_path, "/tikz_implementation/shared_style_path", "shared TikZ style");
  for (const [key, geometry] of Object.entries(library.geometries ?? {})) {
    const where = `/geometries/${key}/reference_system/figure/path`;
    const figurePath = geometry?.reference_system?.figure?.path;
    const name = geometry?.name ?? key;
    const expectedSvg = tikz.generated_outputs.svg.replaceAll("{geometry_name}", name);
    if (figurePath !== expectedSvg) add("figure_path_template", where, `"${figurePath}" differs from the design-standard path "${expectedSvg}"`);
    checkFile(figurePath, where, "SVG figure");
    checkFile(tikz.generated_outputs.pdf.replaceAll("{geometry_name}", name), where, "PDF figure");
    checkFile(tikz.geometry_source_path.replaceAll("{geometry_name}", name), where, "TikZ source");
  }
  return { valid: errors.length === 0, errors, checked };
}

// ---------------------------------------------------------------------------
// Layer 3: geometry-instance validation
// ---------------------------------------------------------------------------

/** Find the definition with exactly this geometry_type_id and version. */
export function resolveGeometryDefinition(library, geometryTypeId, geometryTypeVersion) {
  return Object.values(library?.geometries ?? {}).find(
    (geometry) => geometry?.geometry_type_id === geometryTypeId && geometry?.version === geometryTypeVersion,
  ) ?? null;
}

/**
 * Validate independent parameter values against the resolved library definition.
 * All geometry-specific rules are read from the library. The input is not mutated.
 * Returns { valid, errors, resolved_parameters, derived_parameters }.
 */
export function validateGeometryInstance(library, geometryTypeId, geometryTypeVersion, parameters) {
  const errors = [];
  const add = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  const result = () => ({ valid: errors.length === 0, errors, resolved_parameters: resolved, derived_parameters: derived });
  const resolved = {};
  const derived = {};

  const definition = resolveGeometryDefinition(library, geometryTypeId, geometryTypeVersion);
  if (!definition) {
    const known = Object.values(library?.geometries ?? {}).filter((g) => g?.geometry_type_id === geometryTypeId).map((g) => g.version);
    add("unresolved_geometry_type", known.length
      ? `geometry type ${geometryTypeId} has no version ${JSON.stringify(geometryTypeVersion)} (available: ${known.join(", ")})`
      : `unknown geometry type ${JSON.stringify(geometryTypeId)}`);
    return result();
  }
  const label = `${definition.name} (${definition.geometry_type_id} ${definition.version})`;
  if (!isPlainObject(parameters)) {
    add("parameters_type", `${label}: parameters must be an object`);
    return result();
  }

  const definitions = new Map(definition.parameters.map((p) => [p.name, p]));
  for (const name of Object.keys(parameters)) {
    if (!definitions.has(name)) {
      const isDerived = (definition.derived_parameters ?? []).some((d) => d.name === name);
      add(isDerived ? "derived_parameter_supplied" : "unknown_parameter", isDerived
        ? `${label}: "${name}" is a derived parameter and must not be supplied`
        : `${label}: unknown parameter "${name}"`, { parameter: name });
    }
  }

  for (const parameter of definition.parameters) {
    const { name } = parameter;
    if (!Object.hasOwn(parameters, name)) {
      if (parameter.required) add("missing_required_parameter", `${label}: missing required parameter "${name}"`, { parameter: name });
      else if ("default" in parameter) resolved[name] = parameter.default;
      continue;
    }
    const value = parameters[name];
    if (parameter.type === "number") {
      if (typeof value !== "number") { add("type_mismatch", `${label}: "${name}" must be a number, got ${JSON.stringify(value)}`, { parameter: name }); continue; }
      if (!Number.isFinite(value)) { add("nonfinite_number", `${label}: "${name}" must be finite, got ${value}`, { parameter: name }); continue; }
      for (const message of boundViolations(value, parameter)) add("bound_violation", `${label}: "${name}" = ${value} ${message}${parameter.unit ? ` ${parameter.unit}` : ""}`, { parameter: name });
    } else if (parameter.type === "string") {
      if (typeof value !== "string") { add("type_mismatch", `${label}: "${name}" must be a string, got ${JSON.stringify(value)}`, { parameter: name }); continue; }
      if (Array.isArray(parameter.enum) && !parameter.enum.includes(value)) add("enum_violation", `${label}: "${name}" = "${value}" is not one of ${JSON.stringify(parameter.enum)}`, { parameter: name });
    }
    resolved[name] = value;
  }
  if (errors.length > 0) return result(); // constraints need complete, well-typed numerical inputs

  const numericalValues = Object.fromEntries(
    definition.parameters.filter((p) => p.type === "number" && typeof resolved[p.name] === "number").map((p) => [p.name, resolved[p.name]]),
  );
  for (const constraint of definition.geometric_constraints ?? []) {
    const text = `${constraint.left} ${constraint.operator} ${constraint.right}`;
    try {
      const left = evaluateExpression(parseExpression(constraint.left), numericalValues, constraint.left);
      const right = evaluateExpression(parseExpression(constraint.right), numericalValues, constraint.right);
      if (!compare(left, constraint.operator, right)) add("constraint_violation", `${label}: geometric constraint ${text} is violated (${left} ${constraint.operator} ${right} is false)`, { constraint: text });
    } catch (error) {
      add("constraint_evaluation", `${label}: geometric constraint ${text} could not be evaluated: ${error.message}`, { constraint: text });
    }
  }
  for (const parameter of definition.derived_parameters ?? []) {
    try {
      const value = evaluateExpression(parseExpression(parameter.expression), numericalValues, parameter.expression);
      derived[parameter.name] = value;
      for (const message of boundViolations(value, parameter)) add("derived_bound_violation", `${label}: derived "${parameter.name}" = ${parameter.expression} = ${value} ${message}`, { parameter: parameter.name });
    } catch (error) {
      add("derived_evaluation", `${label}: derived "${parameter.name}" could not be evaluated: ${error.message}`, { parameter: parameter.name });
    }
  }
  return result();
}

export function readJson(relative, root = REPOSITORY_ROOT) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

// Automated tests for the CIVITA Geometry Library validation framework.
// Run from the civita-schema root:
//   node --test tests/
// Structural (JSON Schema) tests need Ajv; set CIVITA_AJV_DIR if it is not
// resolvable from this repository. Without Ajv those tests are reported as
// skipped, never as passed.

import { test, describe } from "node:test";
const structuralTest = test;
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  REPOSITORY_ROOT,
  readJson,
  parseExpression,
  evaluateExpression,
  expressionIdentifiers,
  loadAjv,
  compileLibrarySchema,
  validateLibraryStructure,
  validateLibrarySemantics,
  checkFigureReferences,
  validateGeometryInstance,
} from "../scripts/geometry_library_validation.mjs";

const LIBRARY = readJson("geometry_library.json");
const REFERENCE = readJson("tests/fixtures/geometry_library_reference.json");
const clone = () => structuredClone(LIBRARY);

const ajvBundle = await loadAjv();
const SKIP_STRUCTURAL = ajvBundle.unavailable ? `structural tests skipped: ${ajvBundle.unavailable}` : false;
const compiled = ajvBundle.unavailable ? null : compileLibrarySchema(ajvBundle);
const structural = (library) => validateLibraryStructure(compiled, library);
const semanticCodes = (library) => validateLibrarySemantics(library).errors.map((e) => e.code);

// Scientifically admissible reference instances, one per geometry type.
const REFERENCE_INSTANCES = {
  prism: { length: 400, thickness: 100, depth: 100 },
  cube: { length: 150 },
  cylinder: { length: 200, diameter: 100 },
  notched_prism: { length: 500, thickness: 100, depth: 150, notch_offset: 0, notch_depth: 50, notch_width: 10 },
  dogbone: {
    length: 170, width: 112, dogbone_central_length: 46, dogbone_central_width: 52,
    dogbone_head_length: 32, dogbone_thickness: 24, transition_type: "curved_transition",
  },
  ell_shape: { thickness: 40, ell_length_1: 150, ell_depth_1: 130, ell_length_2: 50, ell_depth_2: 80 },
  notched_cylinder: { length: 300, diameter: 150, notch_depth: 30, notch_width: 10 },
};

const geometry = (name) => LIBRARY.geometries[name];
const check = (name, parameters, version) =>
  validateGeometryInstance(LIBRARY, geometry(name).geometry_type_id, version ?? geometry(name).version, parameters);
const codes = (result) => result.errors.map((e) => e.code);
const withParams = (name, changes) => ({ ...REFERENCE_INSTANCES[name], ...changes });
const without = (name, key) => { const p = { ...REFERENCE_INSTANCES[name] }; delete p[key]; return p; };
const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === "object" && deepFreeze(v)); return Object.freeze(o); };

// A complete, valid future geometry used to show that the framework is not limited to seven types.
const FUTURE_GEOMETRY = {
  geometry_type_id: "GLOB-GEO0099",
  name: "test_slab",
  version: "1.0.0",
  display_name: "Test Slab",
  description: "Hypothetical slab used only to test extensibility.",
  reference_system: {
    type: "right_handed_cartesian",
    figure: { path: "figures/geometries/generated/test_slab.svg" },
    origin: "Corner.", x_axis: "Length.", y_axis: "Width.", z_axis: "Thickness.",
    support_convention: "A prose convention using the *_convention extension mechanism.",
  },
  parameters: [
    { name: "length", required: true, type: "number", unit: "mm", description: "Length.", exclusiveMinimum: 0 },
    { name: "slab_thickness", required: true, type: "number", unit: "mm", description: "Thickness.", exclusiveMinimum: 0, maximum: 1000 },
    { name: "edge_type", required: false, type: "string", enum: ["square", "chamfered"], default: "square", description: "Edge finish." },
  ],
  derived_parameters: [{ name: "slenderness", type: "number", unit: "1", description: "Ratio.", expression: "length / slab_thickness", exclusiveMinimum: 0 }],
  geometric_constraints: [{ left: "length", operator: ">=", right: "2 * slab_thickness" }],
};

// ---------------------------------------------------------------------------

describe("expression grammar", () => {
  test("operator precedence and left associativity", () => {
    const value = (s, v = {}) => evaluateExpression(parseExpression(s), v, s);
    assert.equal(value("2 + 3 * 4"), 14);
    assert.equal(value("(2 + 3) * 4"), 20);
    assert.equal(value("10 - 4 - 3"), 3);
    assert.equal(value("8 / 4 / 2"), 1);
    assert.equal(value("0.5 * (length - 2 * head - central)", { length: 170, head: 32, central: 46 }), 30);
  });

  test("identifiers are collected in order of first use", () => {
    assert.deepEqual(expressionIdentifiers(parseExpression("notch_offset + 0.5 * notch_width - notch_offset")), ["notch_offset", "notch_width"]);
  });

  for (const bad of ["", "   ", "(length", "length)", "length +", "* length", "-length", "length ** 2", "length ^ 2",
    "max(length, 2)", "Math.max(length)", "1e5", "1.2.3", ".5", "2length", "length; process.exit()", "length = 2", "length,2"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => parseExpression(bad), { name: "ExpressionError" }));
  }

  test("division by zero and missing values fail at evaluation", () => {
    assert.throws(() => evaluateExpression(parseExpression("length / (a - a)"), { length: 1, a: 2 }), /division by zero/);
    assert.throws(() => evaluateExpression(parseExpression("length"), {}), /no finite numerical value/);
    assert.throws(() => evaluateExpression(parseExpression("length"), { length: "1" }), /no finite numerical value/);
  });
});

describe("structural validation (JSON Schema Draft 2020-12)", () => {
  const test = (name, fn) => structuralTest(name, { skip: SKIP_STRUCTURAL }, fn);
  test("the authoritative library is valid", () => assert.deepEqual(structural(LIBRARY).errors, []));

  test("a new, correctly structured geometry type is accepted", () => {
    const lib = clone(); lib.geometries.test_slab = structuredClone(FUTURE_GEOMETRY);
    assert.deepEqual(structural(lib).errors, []);
  });

  const cases = {
    "missing top-level field": (l) => { delete l.validation_conventions; },
    "unknown top-level field": (l) => { l.extra = 1; },
    "missing metadata field": (l) => { delete l.metadata.status; },
    "metadata type other than library": (l) => { l.metadata.type = "vocabulary"; },
    "invalid metadata status": (l) => { l.metadata.status = "final"; },
    "missing geometry field": (l) => { delete l.geometries.cube.display_name; },
    "unknown geometry field": (l) => { l.geometries.cube.transition_type = {}; },
    "invalid geometry identifier": (l) => { l.geometries.cube.geometry_type_id = "GEO0002"; },
    "invalid geometry version": (l) => { l.geometries.cube.version = "1.0"; },
    "invalid geometry key": (l) => { l.geometries["Bad-Key"] = l.geometries.cube; },
    "parameters not an array": (l) => { l.geometries.cube.parameters = { length: 1 }; },
    "required not a boolean": (l) => { l.geometries.cube.parameters[0].required = "yes"; },
    "unsupported parameter type": (l) => { l.geometries.cube.parameters[0].type = "integer"; },
    "numerical parameter without unit": (l) => { delete l.geometries.cube.parameters[0].unit; },
    "numerical bound not a number": (l) => { l.geometries.cube.parameters[0].exclusiveMinimum = "0"; },
    "enum on a numerical parameter": (l) => { l.geometries.cube.parameters[0].enum = [1, 2]; },
    "unit on a categorical parameter": (l) => { l.geometries.dogbone.parameters[6].unit = "mm"; },
    "bound on a categorical parameter": (l) => { l.geometries.dogbone.parameters[6].minimum = 0; },
    "categorical parameter without enum": (l) => { delete l.geometries.dogbone.parameters[6].enum; },
    "empty enum": (l) => { l.geometries.dogbone.parameters[6].enum = []; },
    "non-string enum value": (l) => { l.geometries.dogbone.parameters[6].enum = ["linear_transition", 2]; },
    "empty enum value": (l) => { l.geometries.dogbone.parameters[6].enum = ["linear_transition", ""]; },
    "duplicate enum value": (l) => { l.geometries.dogbone.parameters[6].enum = ["curved_transition", "curved_transition"]; },
    "categorical default of the wrong type": (l) => { l.geometries.dogbone.parameters[6].default = 2; },
    "derived parameter without expression": (l) => { delete l.geometries.dogbone.derived_parameters[0].expression; },
    "derived parameter of type string": (l) => { l.geometries.dogbone.derived_parameters[0].type = "string"; },
    "expression with unsupported characters": (l) => { l.geometries.dogbone.derived_parameters[0].expression = "length ^ 2"; },
    "empty constraint side": (l) => { l.geometries.dogbone.geometric_constraints[0].right = ""; },
    "unsupported constraint operator": (l) => { l.geometries.dogbone.geometric_constraints[0].operator = "<="; },
    "coordinate system other than right-handed": (l) => { l.geometries.cube.reference_system.type = "left_handed_cartesian"; },
    "figure path leaving the repository": (l) => { l.geometries.cube.reference_system.figure.path = "../cube.svg"; },
    "absolute figure path": (l) => { l.geometries.cube.reference_system.figure.path = "/figures/cube.svg"; },
    "unknown reference-system field": (l) => { l.geometries.cube.reference_system.colour = "red"; },
    "empty extension convention": (l) => { l.geometries.cube.reference_system.edge_convention = ""; },
    "profile vertex with one coordinate": (l) => { l.geometries.ell_shape.reference_system.profile_convention.vertices_xz[0] = [0]; },
    "profile with invalid extrusion direction": (l) => { l.geometries.ell_shape.reference_system.profile_convention.extrusion.direction = "up"; },
    "missing validation convention": (l) => { delete l.validation_conventions.optional_parameters_and_defaults; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    test(`rejects: ${label}`, () => {
      const lib = clone(); mutate(lib);
      assert.equal(structural(lib).valid, false);
    });
  }
});

describe("semantic validation of the library", () => {
  test("the authoritative library is consistent", () => assert.deepEqual(validateLibrarySemantics(LIBRARY).errors, []));

  test("a new geometry type following the conventions is accepted", () => {
    const lib = clone(); lib.geometries.test_slab = structuredClone(FUTURE_GEOMETRY);
    assert.deepEqual(validateLibrarySemantics(lib).errors, []);
  });

  const cases = {
    name_key_mismatch: (l) => { l.geometries.cube.name = "box"; },
    duplicate_id: (l) => { l.geometries.cube.geometry_type_id = "GLOB-GEO0001"; },
    duplicate_name: (l) => { l.geometries.cube_copy = structuredClone(l.geometries.cube); l.geometries.cube_copy.geometry_type_id = "GLOB-GEO0098"; },
    id_format: (l) => { l.geometries.cube.geometry_type_id = "GLOB-GEO12"; },
    version_format: (l) => { l.geometries.cube.version = "v1"; },
    version_mismatch: (l) => { l.version = "1.0.1"; },
    duplicate_parameter: (l) => { l.geometries.prism.parameters.push(structuredClone(l.geometries.prism.parameters[0])); },
    parameter_name: (l) => { l.geometries.prism.parameters[0].name = "Length"; },
    duplicate_derived: (l) => { l.geometries.dogbone.derived_parameters.push(structuredClone(l.geometries.dogbone.derived_parameters[0])); },
    derived_shadows_independent: (l) => { l.geometries.notched_prism.derived_parameters[0].name = "notch_width"; },
    bounds: (l) => { Object.assign(l.geometries.prism.parameters[0], { minimum: 10, maximum: 5 }); },
    parameter_type_unsupported: (l) => { l.geometries.prism.parameters[0].type = "integer"; },
    numeric_enum: (l) => { l.geometries.prism.parameters[0].enum = [1]; },
    categorical_numeric_keyword: (l) => { l.geometries.dogbone.parameters[6].unit = "mm"; },
    enum_missing: (l) => { l.geometries.dogbone.parameters[6].enum = []; },
    enum_value: (l) => { l.geometries.dogbone.parameters[6].enum = ["curved_transition", 3]; },
    enum_duplicate: (l) => { l.geometries.dogbone.parameters[6].enum = ["curved_transition", "curved_transition"]; },
    default_not_in_enum: (l) => { l.geometries.dogbone.parameters[6].default = "rounded"; },
    default_type: (l) => { l.geometries.dogbone.parameters[6].default = 1; },
    required_with_default: (l) => { l.geometries.dogbone.parameters[6].required = true; },
    expression_syntax: (l) => { l.geometries.dogbone.derived_parameters[0].expression = "0.5 * (length - "; },
    expression_unknown_identifier: (l) => { l.geometries.dogbone.geometric_constraints[0].right = "2 * head_length"; },
    expression_categorical_reference: (l) => { l.geometries.dogbone.geometric_constraints[0].right = "transition_type + 1"; },
    expression_derived_reference: (l) => { l.geometries.dogbone.geometric_constraints[1].right = "dogbone_transition_width"; },
    expression_division_by_zero: (l) => { l.geometries.dogbone.derived_parameters[1].expression = "width / (2 - 2)"; },
    constraint_operator: (l) => { l.geometries.dogbone.geometric_constraints[0].operator = "=="; },
    profile_vertices_plane: (l) => { const p = l.geometries.ell_shape.reference_system.profile_convention; p.vertices_xy = p.vertices_xz; },
    profile_vertices_missing: (l) => { delete l.geometries.ell_shape.reference_system.profile_convention.vertices_xz; },
    profile_corner_axes: (l) => { l.geometries.ell_shape.reference_system.profile_convention.reentrant_corner = { x: 1, y: 2 }; },
    profile_extrusion_axis: (l) => { l.geometries.ell_shape.reference_system.profile_convention.extrusion.axis = "z"; },
    coordinate_system: (l) => { l.geometries.cube.reference_system.type = "cylindrical"; },
  };
  for (const [code, mutate] of Object.entries(cases)) {
    test(`detects ${code}`, () => {
      const lib = clone(); mutate(lib);
      assert.ok(semanticCodes(lib).includes(code), `expected ${code}, got ${JSON.stringify(validateLibrarySemantics(lib).errors)}`);
    });
  }

  test("profile coordinates are parsed against numerical parameters", () => {
    const lib = clone();
    lib.geometries.ell_shape.reference_system.profile_convention.vertices_xz[1] = ["ell_length_3", 0];
    assert.ok(semanticCodes(lib).includes("expression_unknown_identifier"));
  });

  test("error messages identify the geometry and the expression", () => {
    const lib = clone(); lib.geometries.dogbone.geometric_constraints[0].right = "transition_type + 1";
    const [error] = validateLibrarySemantics(lib).errors;
    assert.match(error.message, /\/geometries\/dogbone\/geometric_constraints\/0\/right/);
    assert.match(error.message, /"transition_type \+ 1"/);
  });

  test("malformed structures are reported without crashing", () => {
    for (const bad of [null, [], { geometries: [] }, { geometries: { cube: null } }, { geometries: { cube: { parameters: "x" } } }]) {
      assert.equal(validateLibrarySemantics(bad).valid, false);
    }
  });
});

describe("regression snapshot of the approved definitions", () => {
  test("the set of geometry types matches the snapshot", () => {
    assert.deepEqual(Object.keys(LIBRARY.geometries).sort(), Object.keys(REFERENCE.geometries).sort());
  });
  for (const [name, expected] of Object.entries(REFERENCE.geometries)) {
    test(`${name} matches the snapshot`, () => {
      const g = geometry(name);
      assert.equal(g.geometry_type_id, expected.geometry_type_id);
      assert.equal(g.version, expected.version);
      assert.equal(g.reference_system.figure.path, expected.figure);
      assert.deepEqual(g.parameters.map((p) => {
        const o = { name: p.name, type: p.type, required: p.required };
        for (const k of ["unit", "minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum", "enum", "default"]) if (k in p) o[k] = p[k];
        return o;
      }), expected.parameters);
      assert.deepEqual((g.derived_parameters ?? []).map((d) => {
        const o = { name: d.name, unit: d.unit, expression: d.expression };
        for (const k of ["minimum", "exclusiveMinimum"]) if (k in d) o[k] = d[k];
        return o;
      }), expected.derived_parameters);
      assert.deepEqual((g.geometric_constraints ?? []).map((c) => `${c.left} ${c.operator} ${c.right}`), expected.geometric_constraints);
    });
  }
  test("library metadata remains 1.0.0 draft", () => {
    assert.equal(LIBRARY.metadata.version, "1.0.0");
    assert.equal(LIBRARY.version, "1.0.0");
    assert.equal(LIBRARY.metadata.status, "draft");
  });
});

describe("figure references", () => {
  test("all figures of the authoritative library exist", () => {
    const result = checkFigureReferences(LIBRARY);
    assert.deepEqual(result.errors, []);
    assert.equal(result.checked.length, 1 + 3 * Object.keys(LIBRARY.geometries).length);
  });
  test("a missing figure is reported", () => {
    const lib = clone(); lib.geometries.test_slab = structuredClone(FUTURE_GEOMETRY);
    assert.ok(checkFigureReferences(lib).errors.some((e) => e.code === "figure_missing"));
  });
  test("a path leaving the repository is rejected", () => {
    const lib = clone(); lib.geometries.cube.reference_system.figure.path = "../civita-schema/figures/geometries/generated/cube.svg";
    assert.ok(checkFigureReferences(lib).errors.some((e) => e.code === "figure_path_unsafe"));
  });
});

describe("geometry-instance validation: generic checks for every geometry type", () => {
  test("every geometry type has a reference instance in this test suite", () => {
    assert.deepEqual(Object.keys(LIBRARY.geometries).sort(), Object.keys(REFERENCE_INSTANCES).sort());
  });

  for (const name of Object.keys(LIBRARY.geometries)) {
    const definition = geometry(name);
    describe(name, () => {
      test("reference instance is valid", () => {
        const result = check(name, REFERENCE_INSTANCES[name]);
        assert.deepEqual(result.errors, []);
        assert.equal(result.valid, true);
        assert.deepEqual(Object.keys(result.derived_parameters).sort(), (definition.derived_parameters ?? []).map((d) => d.name).sort());
      });
      for (const p of definition.parameters) {
        if (p.required) test(`missing required "${p.name}" is rejected`, () => assert.ok(codes(check(name, without(name, p.name))).includes("missing_required_parameter")));
        if (p.type === "number") {
          test(`string value for "${p.name}" is rejected`, () => assert.ok(codes(check(name, withParams(name, { [p.name]: String(REFERENCE_INSTANCES[name][p.name]) }))).includes("type_mismatch")));
          for (const v of [NaN, Infinity, -Infinity]) test(`${v} for "${p.name}" is rejected`, () => assert.ok(codes(check(name, withParams(name, { [p.name]: v }))).includes("nonfinite_number")));
        } else {
          test(`invalid value for "${p.name}" is rejected`, () => assert.ok(codes(check(name, withParams(name, { [p.name]: "not_a_listed_value" }))).includes("enum_violation")));
          test(`number for "${p.name}" is rejected`, () => assert.ok(codes(check(name, withParams(name, { [p.name]: 1 }))).includes("type_mismatch")));
        }
      }
      test("unknown parameter is rejected", () => assert.ok(codes(check(name, withParams(name, { unknown_parameter: 10 }))).includes("unknown_parameter")));
      for (const d of definition.derived_parameters ?? []) {
        test(`supplying derived "${d.name}" is rejected`, () => assert.ok(codes(check(name, withParams(name, { [d.name]: 1 }))).includes("derived_parameter_supplied")));
      }
      test("unknown version is rejected", () => assert.ok(codes(check(name, REFERENCE_INSTANCES[name], "9.9.9")).includes("unresolved_geometry_type")));
      test("submitted input is not mutated", () => {
        const input = deepFreeze(structuredClone(REFERENCE_INSTANCES[name]));
        const before = JSON.stringify(input);
        check(name, input);
        assert.equal(JSON.stringify(input), before);
      });
    });
  }

  test("unknown geometry identifier is rejected", () => {
    assert.ok(codes(validateGeometryInstance(LIBRARY, "GLOB-GEO9999", "1.0.0", {})).includes("unresolved_geometry_type"));
  });
  test("non-object parameters are rejected", () => {
    for (const bad of [null, [], "length=1", 5]) assert.ok(codes(validateGeometryInstance(LIBRARY, "GLOB-GEO0002", "1.0.0", bad)).includes("parameters_type"));
  });
  test("a future geometry type is validated from its library definition", () => {
    const lib = clone(); lib.geometries.test_slab = structuredClone(FUTURE_GEOMETRY);
    const ok = validateGeometryInstance(lib, "GLOB-GEO0099", "1.0.0", { length: 400, slab_thickness: 100 });
    assert.equal(ok.valid, true);
    assert.equal(ok.resolved_parameters.edge_type, "square");
    assert.equal(ok.derived_parameters.slenderness, 4);
    assert.ok(codes(validateGeometryInstance(lib, "GLOB-GEO0099", "1.0.0", { length: 100, slab_thickness: 100 })).includes("constraint_violation"));
    assert.ok(codes(validateGeometryInstance(lib, "GLOB-GEO0099", "1.0.0", { length: 4000, slab_thickness: 1001 })).includes("bound_violation"));
  });
});

describe("dogbone instances", () => {
  test("explicit curved_transition", () => {
    const r = check("dogbone", REFERENCE_INSTANCES.dogbone);
    assert.equal(r.valid, true);
    assert.equal(r.resolved_parameters.transition_type, "curved_transition");
    assert.deepEqual(r.derived_parameters, { dogbone_transition_length: 30, dogbone_transition_width: 30 });
  });
  test("explicit linear_transition", () => {
    const r = check("dogbone", withParams("dogbone", { transition_type: "linear_transition" }));
    assert.equal(r.valid, true);
    assert.equal(r.resolved_parameters.transition_type, "linear_transition");
  });
  test("omitted transition_type resolves to the library default", () => {
    const input = without("dogbone", "transition_type");
    const r = check("dogbone", input);
    assert.equal(r.valid, true);
    assert.equal(r.resolved_parameters.transition_type, geometry("dogbone").parameters.find((p) => p.name === "transition_type").default);
    assert.equal(r.resolved_parameters.transition_type, "curved_transition");
    assert.equal("transition_type" in input, false, "the default must not be inserted into the input");
  });
  test("unsupported categorical value", () => assert.deepEqual(codes(check("dogbone", withParams("dogbone", { transition_type: "rounded" }))), ["enum_violation"]));
  test("categorical value of the wrong type", () => assert.deepEqual(codes(check("dogbone", withParams("dogbone", { transition_type: 2 }))), ["type_mismatch"]));
  test("central region wider than the heads", () => {
    const r = check("dogbone", withParams("dogbone", { dogbone_central_width: 120 }));
    assert.ok(codes(r).includes("constraint_violation"));
    assert.ok(codes(r).includes("derived_bound_violation"));
  });
  test("no room for the transition regions", () => {
    const r = check("dogbone", withParams("dogbone", { length: 2 * 32 + 46 }));
    assert.ok(codes(r).includes("constraint_violation"));
    assert.equal(r.derived_parameters.dogbone_transition_length, 0);
    assert.ok(codes(r).includes("derived_bound_violation"));
  });
});

describe("notched prism instances", () => {
  test("valid centered notch and derived tip radius", () => {
    const r = check("notched_prism", REFERENCE_INSTANCES.notched_prism);
    assert.equal(r.valid, true);
    assert.equal(r.derived_parameters.notch_tip_radius, 5);
  });
  test("positive and negative notch offsets", () => {
    for (const offset of [100, -100, 244.9, -244.9]) assert.equal(check("notched_prism", withParams("notched_prism", { notch_offset: offset })).valid, true, `offset ${offset}`);
  });
  test("notch depth equal to the specimen depth", () => assert.ok(codes(check("notched_prism", withParams("notched_prism", { notch_depth: 150 }))).includes("constraint_violation")));
  test("notch depth without a straight-sided segment", () => assert.ok(codes(check("notched_prism", withParams("notched_prism", { notch_depth: 5 }))).includes("constraint_violation")));
  test("nonpositive notch depth", () => assert.ok(codes(check("notched_prism", withParams("notched_prism", { notch_depth: 0 }))).includes("bound_violation")));
  test("notch opening beyond the specimen length", () => {
    for (const offset of [245, -245, 300]) assert.ok(codes(check("notched_prism", withParams("notched_prism", { notch_offset: offset }))).includes("constraint_violation"), `offset ${offset}`);
  });
});

describe("notched cylinder instances", () => {
  test("valid circumferential groove and derived tip radius", () => {
    const r = check("notched_cylinder", REFERENCE_INSTANCES.notched_cylinder);
    assert.equal(r.valid, true);
    assert.equal(r.derived_parameters.notch_tip_radius, 5);
  });
  test("notch depth beyond the radius", () => assert.ok(codes(check("notched_cylinder", withParams("notched_cylinder", { notch_depth: 80 }))).includes("constraint_violation")));
  test("notch width not less than the length", () => assert.ok(codes(check("notched_cylinder", withParams("notched_cylinder", { notch_width: 300 }))).includes("constraint_violation")));
  test("zero straight-sided portion", () => assert.ok(codes(check("notched_cylinder", withParams("notched_cylinder", { notch_depth: 5 }))).includes("constraint_violation")));
  test("zero notch-root radius", () => assert.ok(codes(check("notched_cylinder", withParams("notched_cylinder", { notch_depth: 75 }))).includes("constraint_violation")));
});

describe("ell shape instances", () => {
  test("valid profile", () => assert.equal(check("ell_shape", REFERENCE_INSTANCES.ell_shape).valid, true));
  test("ell_length_2 not less than ell_length_1", () => {
    for (const v of [150, 200]) assert.ok(codes(check("ell_shape", withParams("ell_shape", { ell_length_2: v }))).includes("constraint_violation"));
  });
  test("ell_depth_2 not less than ell_depth_1", () => {
    for (const v of [130, 140]) assert.ok(codes(check("ell_shape", withParams("ell_shape", { ell_depth_2: v }))).includes("constraint_violation"));
  });
});

describe("command-line interface", () => {
  test("validates the authoritative library and exits with status 0", () => {
    const cli = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, "scripts", "validate_geometry_library.mjs")], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /\[PASSED\] semantic/);
    assert.match(cli.stdout, /\[PASSED\] figures/);
    assert.match(cli.stdout, SKIP_STRUCTURAL ? /\[SKIPPED\] structural/ : /\[PASSED\] structural/);
  });
});

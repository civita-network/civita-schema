# CIVITA Common Specifications

## JSON filename convention

- Use lowercase letters and underscores in CIVITA JSON filenames, omitting the `civita_` prefix.
- Use `.schema.json` for formal JSON Schema documents, such as [the metadata schema](metadata.schema.json).
- Use `.json` for other specifications, including database hierarchies, controlled vocabularies, and scientific libraries.
- Retain the `civita` namespace in globally unique metadata identifiers, such as `civita.experimental.database_hierarchy`.
- Keep existing filenames that already follow this convention. All new specification files must follow it.

## Literature sources

The [literature sources schema](literature_sources.schema.json) and [source types vocabulary](source_types.json) are shared by the CIVITA Experimental and Computational Databases. Each database assigns its own `source_id` values in the `SRC0001` format. A matching ID in the other database does not establish that two records describe the same publication. Record `authors` as a single string in publication order.

### Validate literature source records

The `x-civita-vocabulary` annotation on `source_type` names the vocabulary file relative to the schema file. Run [the schema generator](build_literature_sources_schema.mjs) with Node.js before dataset validation. It reads the `term` values from that file and emits a Draft 2020-12 validation schema with an `enum` for `source_type`. Use the generated schema to validate every record in the dataset's `literature_sources` collection. An unknown `source_type` fails validation.

To validate one record with Node.js and PowerShell 7.5 or later, run these commands from the repository root:

```powershell
$schema = node ./build_literature_sources_schema.mjs | Out-String
if ($LASTEXITCODE -ne 0) { throw 'Could not build the literature sources schema' }
if (-not (Test-Json -LiteralPath ./literature_source.json -Schema $schema)) {
    throw 'Invalid literature source record'
}
```

## Keywords

The [keywords schema](keywords.schema.json) defines free-text keyword records for both CIVITA databases. The `source_id` in each record identifies a literature source within the same database.

At final submission, validate the `keywords` array against the schema. Its `minItems: 3` sets a minimum for the whole array. A dataset with multiple literature sources also needs a count for every source listed in `literature_sources`, including sources with zero keyword records. Count only records whose `source_id` matches the source. Reject the final submission if any source has fewer than three keywords. Defer both minimums when saving work in progress.

This PowerShell 7.5 example assumes `$dataset` contains the final submission and its source references have already been checked.

```powershell
$keywordJson = ConvertTo-Json -InputObject @($dataset.keywords) -Depth 5
if (-not (Test-Json -Json $keywordJson -SchemaFile ./keywords.schema.json)) {
    throw 'Invalid keyword collection'
}
foreach ($source in $dataset.literature_sources) {
    $count = @($dataset.keywords | Where-Object { $_.source_id -ceq $source.source_id }).Count
    if ($count -lt 3) {
        throw "Fewer than three keywords for $($source.source_id)"
    }
}
```

## Geometry library

The [CIVITA Geometry Library](geometry_library.json) is the shared registry of geometry types, their parametrizations, and their local coordinate systems. Each geometry instance records its local identifier and parameter values together with the global `geometry_type_id` and `geometry_type_version` that define their meaning.

The authoritative [reference figures](figures/geometries/) are maintained with the JSON definitions. Resolve the library and its repository-relative figure paths at the same immutable commit or release. Update the JSON and figure together when a geometry changes. Draft definitions can be corrected at their existing versions before the first release. A change to the interpretation of a released geometry requires a new geometry type version.

`metadata.version` identifies the library specification as a whole. The root-level `version` mirrors it for compatibility. Each geometry type retains its independent version, which identifies the definition used by existing instances.

The figures in `civita-documentation` are legacy copies. Stage 2 will synchronize them from the common library and generate the corresponding LaTeX from a pinned revision.

### Derived parameters and geometric constraints

A geometry definition's `parameters` array lists the independent inputs supplied by a geometry instance. Resolve the geometry by `geometry_type_id` and `geometry_type_version`, then validate the inputs against their declared types. Independent parameters are numerical or categorical: apply numerical bounds to numerical parameters, check categorical values against their `enum`, and use the declared `default` for an omitted optional parameter. Apply any `geometric_constraints` and calculate `derived_parameters` from the inputs. Check each derived value against its own bounds. Dogbone transition dimensions are derived outputs.

Arithmetic expressions accept finite decimal literals matching `[0-9]+(\.[0-9]+)?`, names of numerical independent parameters in the same definition, parentheses, and the binary operators `+`, `-`, `*`, and `/`. Examples include `12`, `12.5`, `0.5 * notch_width`, and `0.5 * (length - 2 * dogbone_head_length)`. Spaces between tokens are allowed. Leading or trailing decimal points, scientific notation, unary signs, exponentiation, and function calls are rejected, including `.5`, `12.`, `1e5`, `-2`, `notch_width ** 2`, and `sqrt(diameter)`.

Evaluate parentheses first, then multiplication and division, then addition and subtraction. Operators at the same precedence group from left to right. Constraint entries compare the `left` and `right` expressions using their `operator` (`>`, `>=`, or `<`). Reject division by zero and nonfinite results. The reference parser evaluates the restricted grammar directly.

The library specifies these rules. [`scripts/geometry_library_validation.mjs`](scripts/geometry_library_validation.mjs) provides a reference implementation that applications can reuse or follow.

### Validation

The library is validated in three layers:

1. **Structural.** [`geometry_library.schema.json`](geometry_library.schema.json) (JSON Schema Draft 2020-12) defines the shape of `geometry_library.json`. It covers required fields, identifier and version patterns, metadata (through [`metadata.schema.json`](metadata.schema.json), with `type` fixed to `library`), and numerical parameters (`type: number`, a `unit`, optional bounds, no `enum`). It also covers categorical parameters (`type: string`, a nonempty `enum` of unique lowercase_with_underscores values, an optional string `default`, no unit or bounds), derived parameters, constraint operators (`>`, `>=`, `<`), and the reference-system fields, including the structured `profile_convention`. Additional geometry-specific reference-system conventions must use names ending in `_convention`. The set of geometry types is open.
2. **Semantic.** Relationships that JSON Schema cannot express are checked by the validator:
   - each `geometries` key matches its `name`, and identifiers and names are unique;
   - parameter names are unique, and derived names do not repeat independent ones;
   - numerical bounds are consistent, and each `default` matches its type, lies in its `enum` or bounds, and appears only on optional parameters;
   - every expression parses and references only numerical independent parameters;
   - profile vertices and the extrusion axis match the declared plane.
3. **Figures.** The validator checks that each geometry's SVG, PDF, and TikZ source, and the shared TikZ style, exist inside the repository and are nonempty. File locations follow `tikz_implementation` in the figure design standard.

Run the validator and tests from the repository root with Node.js 24 LTS:

```bash
npm ci
npm run validate:geometry
npm run test:geometry
```

The lockfile pins the development dependencies [Ajv](https://ajv.js.org/) and `ajv-formats`. The standard command runs in strict mode and requires JSON parsing, structural validation with format checks, semantic validation, and figure-reference validation to pass. A failed or unavailable stage yields exit status 1. The test suite requires both locally resolvable dependencies and always runs the structural cases. GitHub Actions runs the same commands for relevant changes pushed to `main` or proposed in pull requests targeting `main`, and supports manual runs.

`validateGeometryInstance(library, geometry_type_id, geometry_type_version, parameters)` validates one instance against the exact resolved definition. It rejects unresolved types or versions, missing required parameters, unknown or derived parameter names, wrong types, nonfinite numbers, out-of-bounds values, and values outside an `enum`. It then evaluates the geometric constraints, calculates the derived parameters, and checks their bounds. It returns `valid`, `errors`, `resolved_parameters` (submitted values plus the defaults of omitted optional parameters, such as `transition_type: "curved_transition"` for a dogbone), and `derived_parameters`. Defaults are not inserted into the submitted record. All rules are read from the library entry, so new geometry types that follow these conventions need no code changes.

The validator does not prove that a geometry's constraints can be satisfied together. Division by an expression that evaluates to zero is detected for specific instances. The validator checks that the prose in `validation_conventions` and `global_conventions` is present.

#### Scientific regression snapshot

The tests compare the seven approved definitions with [`tests/fixtures/geometry_library_reference.json`](tests/fixtures/geometry_library_reference.json). Routine validation must never update this snapshot automatically. A proposed change to an approved definition requires scientific review. After approval, the snapshot may be deliberately updated under the existing CIVITA geometry-type versioning rules. The library-wide version identifies the specification as a whole and is managed separately. Published interpretations must remain reproducible from the immutable commits or releases that contain the corresponding definitions and figures.

## License and Copyright

Original technical schemas, interface definitions, and the build script are licensed under [MIT](LICENSE). Eligible terms in `source_types.json` and public metadata use [CC0 1.0](LICENSE-CC0). See [the local license scope](LICENSING.md) for scientific documentation and linked assets. Copyright in original software contributions remains with the respective contributors or other applicable rights holders.

See the [CIVITA licensing policy](https://github.com/civita-network/civita/blob/main/LICENSING.md), [authors and attribution](https://github.com/civita-network/civita/blob/main/AUTHORS.md), and [contribution guidelines](https://github.com/civita-network/civita/blob/main/CONTRIBUTING.md).

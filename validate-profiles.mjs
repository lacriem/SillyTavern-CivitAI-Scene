/**
 * Offline validator for the CivitAI imageGen profiles.
 *
 * Reads the official OpenAPI document and checks that the payloads built by
 * `buildWorkflowInput()` for every profile in engines.js are accepted by the matching
 * schema: no unknown fields (the schemas are closed with `additionalProperties: false`),
 * every required field present, and every value conforming to its declared type,
 * enum, length, range and `multipleOf` constraint.
 *
 * Why it builds MANY payloads per profile
 * --------------------------------------
 * The previous version built exactly ONE payload per profile, from that profile's own
 * declared defaults, and therefore reported "0 failing profiles" while real defects
 * were present: it could not see an out-of-spec bound (the profile's own min/max were
 * the only bounds ever compared), a non-first enum member (`bf16` precision on
 * hidream-i1 was never sent because `fp8` was the declared first option), a
 * fractional value on an int32 field, or anything reachable only through a preset
 * import. So this version sweeps:
 *
 *   1. every non-default member of every declared enum (model, version, modelVersion,
 *      sampler, scheduler, and each `extras[]` enum),
 *   2. every non-default integer-typed extra,
 *   3. the min / max / default of every numeric knob, plus out-of-range probes to
 *      prove the profile's own clamp is doing its job,
 *   4. a `JSON.stringify` round-trip so `undefined` members (which silently disappear
 *      from the wire) are caught,
 *   5. a required-field check with a non-empty value.
 *
 * Coverage is reported per `engine` AND per `model` AND per `version`, not just per
 * `engine/ecosystem`, because several schemas discriminate on `model` (a Flux 2 Klein
 * checkpoint and a Flux 2 Dev one live behind the same `engine: flux2`) or on
 * `version` (WAN 2.2 / 2.5 / 2.7), so an ecosystem-level roll-up hides untested
 * variants entirely.
 *
 * Dependency-free: the YAML subset it needs is parsed in this file.
 *
 * Usage:
 *   node validate-profiles.mjs [path-to-openapi.yaml]
 *
 * The spec is downloaded from
 * https://orchestration.civitai.com/v2/consumer/recipes/imageGen/openapi.yaml
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_PROFILES, buildWorkflowInput, airBucketsFor, airBucketAliases, imageSizesFor, promptGuideFor } from './engines.js';

const SPEC_URL = 'https://orchestration.civitai.com/v2/consumer/recipes/imageGen/openapi.yaml';
const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.resolve(here, process.argv[2] || 'imagegen.yaml');

if (!fs.existsSync(specPath)) {
    console.error(`OpenAPI document not found: ${specPath}`);
    console.error(`Download it first:\n  curl -o "${specPath}" ${SPEC_URL}`);
    process.exit(2);
}

const schemas = loadYaml(fs.readFileSync(specPath, 'utf8')).components.schemas;

/**
 * Minimal YAML subset loader (block maps, block sequences, scalars, quoted strings).
 * @param {string} text YAML source
 * @returns {any} Parsed value
 */
function loadYaml(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim() && !/^\s*#/.test(line));
    let pos = 0;

    const indentOf = line => line.match(/^ */)[0].length;
    const scalar = raw => {
        const v = raw.trim();
        if (v === '' || v === '~' || v === 'null') return null;
        if (v === 'true') return true;
        if (v === 'false') return false;
        if (/^-?\d+$/.test(v)) return Number(v);
        if (/^-?\d*\.\d+$/.test(v)) return Number(v);
        if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(v);
        if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
        if (v.startsWith('[') && v.endsWith(']')) {
            const inner = v.slice(1, -1).trim();
            return inner ? inner.split(',').map(x => scalar(x)) : [];
        }
        return v;
    };

    function parseBlock(minIndent) {
        // sequence?
        if (pos < lines.length && lines[pos].trim().startsWith('- ') && indentOf(lines[pos]) === minIndent) {
            const arr = [];
            while (pos < lines.length) {
                const line = lines[pos];
                if (indentOf(line) !== minIndent || !line.trim().startsWith('- ')) break;
                const rest = line.trim().slice(2);
                const childIndent = minIndent + 2;
                if (rest.includes(': ') || /:$/.test(rest)) {
                    // inline first key of a mapping item
                    lines[pos] = ' '.repeat(childIndent) + rest;
                    arr.push(parseBlock(childIndent));
                } else {
                    arr.push(scalar(rest));
                    pos++;
                }
            }
            return arr;
        }

        const obj = {};
        while (pos < lines.length) {
            const line = lines[pos];
            const ind = indentOf(line);
            if (ind < minIndent) break;
            if (ind > minIndent) break;
            const trimmed = line.trim();
            if (trimmed.startsWith('- ')) break;
            const m = /^([^:]+):\s*(.*)$/.exec(trimmed);
            if (!m) { pos++; continue; }
            const key = scalar(m[1]);
            const rest = m[2];
            pos++;
            if (rest !== '') {
                obj[key] = scalar(rest);
            } else if (pos < lines.length && (indentOf(lines[pos]) > minIndent || lines[pos].trim().startsWith('- '))) {
                obj[key] = parseBlock(indentOf(lines[pos]));
            } else {
                obj[key] = null;
            }
        }
        return obj;
    }

    return parseBlock(0);
}

/**
 * Flattens $ref and allOf composition into a single object schema.
 *
 * Unlike a plain merge, a child that redeclares a property REPLACES the parent's
 * version (the last allOf entry wins in JSON Schema), which is what makes the
 * per-model width/quantity/steps overrides in this spec apply.
 * @param {any} node Schema node
 * @param {Set<string>} [seen] Guard against reference cycles
 * @returns {any} Flattened schema
 */
function deref(node, seen = new Set()) {
    if (!node || typeof node !== 'object') return node;
    if (node.$ref) {
        const name = node.$ref.replace('#/components/schemas/', '');
        if (seen.has(name)) return {};
        seen.add(name);
        return deref(schemas[name], seen);
    }
    if (Array.isArray(node.allOf)) {
        const out = { type: 'object', properties: {}, required: [] };
        for (const part of node.allOf) {
            const r = deref(part, seen) ?? {};
            Object.assign(out.properties, r.properties ?? {});
            out.required.push(...(r.required ?? []));
        }
        return out;
    }
    if (node.enum === undefined && node.type === undefined && node.properties === undefined) {
        // e.g. a bare `$ref` to an enum component reached through a property
        return node;
    }
    return node;
}

/** Resolves a property schema, following `$ref` to a named enum. */
function derefProp(node) {
    if (node?.$ref) {
        return schemas[node.$ref.replace('#/components/schemas/', '')] ?? node;
    }
    return node;
}

/**
 * Every schema that can serve an imageGen create request, with the full constraint set
 * kept per property (not just enums and numeric ranges, which is all the old check had).
 */
const candidates = [];
for (const [name, raw] of Object.entries(schemas)) {
    const flat = deref(raw);
    const props = flat.properties ?? {};
    if (!props.engine?.enum || !props.prompt) continue;
    const canCreate = props.operation?.enum?.includes('createImage');
    const hasNoOperation = !props.operation && /Input$/.test(name);
    if (!canCreate && !hasNoOperation) continue;

    /** Per-property constraint bundles. */
    const fields = {};
    for (const [key, value] of Object.entries(props)) {
        const resolved = derefProp(value);
        fields[key] = {
            enum: Array.isArray(resolved?.enum) ? resolved.enum : null,
            type: resolved?.type ?? null,
            format: resolved?.format ?? null,
            minimum: resolved?.minimum,
            maximum: resolved?.maximum,
            minLength: resolved?.minLength,
            maxLength: resolved?.maxLength,
            multipleOf: resolved?.multipleOf,
            pattern: resolved?.pattern ?? null,
            default: resolved?.default,
        };
    }

    candidates.push({
        name,
        engine: props.engine.enum[0],
        ecosystem: props.ecosystem?.enum?.[0] ?? null,
        modelEnum: props.model?.enum ?? null,
        versionEnum: props.version?.enum ?? null,
        modelVersionEnum: fields.modelVersion?.enum ?? null,
        hasOperation: !!canCreate,
        required: new Set(flat.required ?? []),
        props: Object.keys(props),
        fields,
        loras: props.loras ?? null,
    });
}

/**
 * Describes one violation, always naming the profile, the field, the value that was
 * actually sent and the spec clause it breaks.
 */
const clause = (what, detail) => `${what}${detail ? ` (${detail})` : ''}`;

/**
 * Reports everything in the payload that the schema would reject.
 *
 * @param {any} schema Candidate schema
 * @param {object} input Built payload
 * @param {{requireable?: boolean}} [opts] `requireable:false` skips the `required` sweep,
 *   used for schemas whose `required` list mentions an `operation` the profile
 *   deliberately omits (WAN discriminates on `version`, not `operation`, so the
 *   provider-discriminated leaves require a field the profile never sent). Their FIELD
 *   constraints still apply.
 * @returns {string[]} Problems
 */
function check(schema, input, opts = {}) {
    const errs = [];
    const where = v => `[${v}]`;

    // Round-trip first: a member holding `undefined` is dropped by JSON.stringify, so a
    // payload that only satisfies the schema in memory can still be invalid on the wire.
    let wire;
    try {
        wire = JSON.parse(JSON.stringify(input));
    } catch (err) {
        return [`${where('')} payload is not JSON-serialisable: ${err.message}`];
    }

    for (const key of Object.keys(input)) {
        if (input[key] === undefined) {
            errs.push(`${clause('field is undefined', `${key} — JSON.stringify drops it, so it will not reach the server`)}`);
        }
    }

    for (const key of Object.keys(wire)) {
        if (!schema.props.includes(key)) {
            errs.push(`${clause(`"${key}" is not a field of this schema`, `additionalProperties:false`)}`);
        }
    }

    for (const key of schema.required) {
        if (opts.requireable === false) break;
        const value = wire[key];
        if (!(key in wire)) {
            errs.push(`${clause(`missing required "${key}"`, `required:[${[...schema.required].join(',')}]`)}`);
        } else if (value === null || value === '' || (Array.isArray(value) && value.length === 0) && key !== 'imageStyleReferences') {
            errs.push(`${clause(`required "${key}" is present but empty`, `required:[${[...schema.required].join(',')}] sent ${JSON.stringify(value)}`)}`);
        }
    }

    for (const [key, value] of Object.entries(wire)) {
        const f = schema.fields[key];
        if (!f) continue;

        if (f.enum && !f.enum.includes(value)) {
            errs.push(`${clause(`${key}=${JSON.stringify(value)} is not one of [${f.enum.join('|')}]`, `enum:${f.enum.join('|')}`)}`);
        }

        // Type conformance, not just numeric range: `integer` rejects 2.5 outright.
        const types = Array.isArray(f.type) ? f.type.filter(t => t !== 'null') : (f.type ? [f.type] : []);
        const isNull = value === null;
        if (!types.length) {
            // untyped in the spec — nothing to enforce
        } else if (!types.includes('null') && isNull) {
            errs.push(`${clause(`${key}=null is not allowed`, `type:${f.type}`)}`);
        } else if (!isNull) {
            if (typeof value === 'number' && types.includes('integer') && !Number.isInteger(value)) {
                errs.push(`${clause(`${key}=${value} is not an integer`, `type:integer format:${f.format ?? '?'}`)}`);
            }
            if (typeof value !== 'number' && types.includes('number') && types.includes('integer')) {
                errs.push(`${clause(`${key}=${JSON.stringify(value)} is not a number`, `type:${f.type}`)}`);
            }
        }

        if (typeof value === 'number') {
            if (f.minimum !== undefined && value < f.minimum) {
                errs.push(`${clause(`${key}=${value} is below the minimum`, `${JSON.stringify(value)} < minimum:${f.minimum}`)}`);
            }
            if (f.maximum !== undefined && value > f.maximum) {
                errs.push(`${clause(`${key}=${value} is above the maximum`, `${JSON.stringify(value)} > maximum:${f.maximum}`)}`);
            }
            if (f.multipleOf !== undefined && value % f.multipleOf !== 0) {
                errs.push(`${clause(`${key}=${value} is not a multiple of ${f.multipleOf}`, `multipleOf:${f.multipleOf}`)}`);
            }
        }

        if (typeof value === 'string') {
            if (f.minLength !== undefined && value.length < f.minLength) {
                errs.push(`${clause(`${key} is shorter than minLength`, `${JSON.stringify(value).slice(0, 40)} (len ${value.length}) < ${f.minLength}`)}`);
            }
            if (f.maxLength !== undefined && value.length > f.maxLength) {
                errs.push(`${clause(`${key} is longer than maxLength`, `len ${value.length} > maxLength:${f.maxLength}`)}`);
            }
            if (f.pattern && !new RegExp(f.pattern).test(value)) {
                errs.push(`${clause(`${key}=${JSON.stringify(value).slice(0, 60)} does not match pattern`, f.pattern.slice(0, 70))}`);
            }
        }

        if (Array.isArray(value)) {
            if (f.minItems !== undefined && value.length < f.minItems) {
                errs.push(`${clause(`${key} has ${value.length} item(s), below minItems`, `minItems:${f.minItems}`)}`);
            }
            if (f.maxItems !== undefined && value.length > f.maxItems) {
                errs.push(`${clause(`${key} has ${value.length} item(s), above maxItems`, `maxItems:${f.maxItems}`)}`);
            }
        }
    }

    if ('loras' in wire) {
        errs.push(...checkLoras(schema.loras, wire.loras));
    }

    return errs;
}

/**
 * The canonical AIR pattern, copied from the spec's ImageGenInputLora.air field.
 * The map form declares no pattern at all, so the same grammar is applied to keys.
 */
const AIR_PATTERN = /^(?:urn:)?(?:air:)?(?:(?:[a-zA-Z0-9_\-/]+):)?(?:(?:[a-zA-Z0-9_\-/]+):)?[a-zA-Z0-9_\-/]+:[a-zA-Z0-9_\-/.]+(?:@[a-zA-Z0-9_\-/.=,%+:]+)?(?:\.[a-zA-Z0-9_\-]+)?$/;

/**
 * Validates the `loras` payload against the shape the schema declares.
 * @param {any} loraSchema The schema's `loras` property
 * @param {any} value Encoded value produced by buildWorkflowInput()
 * @returns {string[]} Problems
 */
function checkLoras(loraSchema, value) {
    const errs = [];

    if (!loraSchema) {
        return ['loras is not a field of this schema'];
    }

    if (loraSchema.type === 'object' && loraSchema.additionalProperties) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return [`loras must be a map of AIR -> weight, got ${Array.isArray(value) ? 'an array' : typeof value}`];
        }
        // An own-key check: a plain assignment of the key "__proto__" sets the
        // prototype instead of adding a member, which silently loses the LoRA.
        for (const air of Object.getOwnPropertyNames(value)) {
            if (air === '__proto__' && !Object.prototype.hasOwnProperty.call(value, '__proto__')) {
                errs.push(`lora key "${air}" was swallowed by the prototype instead of becoming an own key`);
            }
        }
        for (const [air, weight] of Object.entries(value)) {
            if (!AIR_PATTERN.test(air)) {
                errs.push(`lora key "${air}" is not an AIR URN`);
            }
            const w = derefProp(loraSchema.additionalProperties);
            if (typeof weight !== 'number') {
                errs.push(`lora weight for "${air}" must be a number, got ${typeof weight}`);
            } else if (w?.maximum !== undefined && weight > w.maximum) {
                errs.push(`lora weight ${weight} for "${air}" is above maximum:${w.maximum}`);
            } else if (w?.minimum !== undefined && weight < w.minimum) {
                errs.push(`lora weight ${weight} for "${air}" is below minimum:${w.minimum}`);
            }
        }
        return errs;
    }

    if (loraSchema.type === 'array') {
        if (!Array.isArray(value)) {
            return [`loras must be an array of { air, strength }, got ${typeof value}`];
        }
        const item = deref(loraSchema.items) ?? {};
        const itemProps = new Set(Object.keys(item.properties ?? {}));
        const strength = derefProp(item.properties?.strength ?? {});
        for (const entry of value) {
            if (typeof entry !== 'object' || entry === null) {
                errs.push('each lora entry must be an object');
                continue;
            }
            for (const key of Object.keys(entry)) {
                if (!itemProps.has(key)) {
                    errs.push(`lora entry field "${key}" is not allowed`);
                }
            }
            for (const key of item.required ?? []) {
                if (!(key in entry)) {
                    errs.push(`lora entry is missing "${key}"`);
                }
            }
            if (typeof entry.air !== 'string' || !AIR_PATTERN.test(entry.air)) {
                errs.push(`lora air "${entry.air}" is not an AIR URN`);
            }
            if (typeof entry.strength !== 'number') {
                errs.push(`lora strength for "${entry.air}" must be a number, got ${typeof entry.strength}`);
            }
            if (strength.minimum !== undefined && entry.strength < strength.minimum) {
                errs.push(`lora strength ${entry.strength} is below minimum:${strength.minimum}`);
            }
            if (strength.maximum !== undefined && entry.strength > strength.maximum) {
                errs.push(`lora strength ${entry.strength} is above maximum:${strength.maximum}`);
            }
        }
        return errs;
    }

    return [`unsupported loras schema shape: ${JSON.stringify(loraSchema).slice(0, 80)}`];
}

/**
 * Selects the schemas a profile could legitimately be validated against.
 *
 * `overrides` carries the model / version / provider a SPECIFIC payload case uses,
 * because several schemas discriminate on `model` (HiDream O1 has a separate schema
 * per model) or on `version` (WAN) or on `provider` (the FAL variants). Resolving once
 * from the profile default therefore picked the wrong schema for every non-default
 * case — which is precisely the class of bug a single-payload validator cannot see.
 *
 * The whole discriminator closure is kept, not just the first match: a parent like
 * `WanImageGenInput` genuinely does not declare `provider` or `usePro`, and only the
 * deeper `Wan27FalTextToImageInput` does. A payload is accepted when at least one
 * reachable schema accepts it.
 *
 * @param {any} profile Engine profile
 * @param {{model?: string, version?: string}} [overrides] Values from the payload case
 * @returns {any[]} Matching schemas, deepest first
 */
function schemasFor(profile, overrides = {}) {
    const provider = profile.fixed?.provider;
    const matches = candidates.filter(s => s.engine === profile.engine)
        .filter(s => (profile.ecosystem ? s.ecosystem === profile.ecosystem : !s.ecosystem))
        .filter(s => {
            // A HOSTILE override value must not narrow the candidate set: it is about to
            // be replaced by a legal member, so the schemas for the DECLARED values are
            // the relevant oracles. Filtering on "not in any enum" would leave only the
            // un-discriminated parent and report nonsense.
            const model = (overrides.model && profile.modelOptions?.includes(overrides.model)) ? overrides.model : profile.model;
            return model && s.modelEnum ? s.modelEnum.includes(model) : !s.modelEnum;
        })
        .filter(s => {
            const version = (overrides.version && profile.versionOptions?.includes(overrides.version)) ? overrides.version : profile.version;
            return version && s.versionEnum ? s.versionEnum.includes(version) : !s.versionEnum;
        })
        .filter(s => !provider || !s.fields.provider?.enum || s.fields.provider.enum.includes(provider));

    if (matches.length <= 1) return matches;

    // Rank by how many of the fields this profile actually uses the schema declares:
    // a deeper, more specific schema declares more of them than its parent.
    const used = new Set([
        ...(profile.checkpoint ? [profile.checkpoint] : []),
        ...(profile.extraCheckpoints ?? []).map(x => x.field),
        profile.count, profile.guidance, profile.stepsField, profile.sampler, profile.scheduler,
        ...Object.keys(profile.fixed ?? {}),
        ...(profile.extras ?? []).map(e => e.key),
    ].filter(Boolean));
    const score = s => [...used].filter(k => s.props.includes(k)).length;

    return matches.slice().sort((a, b) => score(b) - score(a) || b.name.length - a.name.length);
}

// A representative parameter set, matching what submitWorkflow() passes in.
const VALUES = {
    prompt: 'a cat, 1girl, sitting on a bed, warm light',
    negativePrompt: 'bad hands, ugly',
    aspectRatio: '4:3',
    quantity: 1, seed: 777,
    checkpoint: 'urn:air:zimage:checkpoint:civitai:999@1',
    extraCheckpoints: {
        vaeModel: 'urn:air:flux1:vae:civitai:11@2',
        clipLModel: 'urn:air:flux1:clipL:civitai:12@3',
        t5XXLModel: 'urn:air:flux1:t5xxl:civitai:13@4',
    },
    extraFlags: {},
    loras: [
        { air: 'urn:air:sdxl:lora:civitai:4242@9999', strength: 0.85 },
        { air: 'urn:air:flux1:lora:civitai:777@888', strength: -0.4 },
    ],
};

/** Airs that are plausible for a given profile, used so the LoRA sweep is ecosystem-clean. */
function sampleLoras(profile, n) {
    const buckets = airBucketsFor(profile);
    const bucket = buckets[0] ?? 'sdxl';
    return Array.from({ length: n }, (_, i) => ({ air: `urn:air:${bucket}:lora:civitai:${100 + i}@${200 + i}`, strength: i % 2 ? -0.4 : 0.85 }));
}

/**
 * Builds every payload worth checking for a profile.
 *
 * Each entry is `{label, values}` — the label is printed with any failure so it is
 * obvious WHICH sweep produced it (e.g. `modelVersion=9b-kv`).
 * @param {any} profile Engine profile
 * @returns {Array<{label: string, values: object}>} Payload cases
 */
function buildCases(profile) {
    const base = {
        ...VALUES,
        loras: sampleLoras(profile, 2),
        width: profile.defaultWidth ?? 1024,
        height: profile.defaultHeight ?? 1024,
        guidance: profile.defaultGuidance,
        steps: profile.defaultSteps,
        aspectRatio: profile.ratios?.[0] ?? '1:1',
        imageSize: imageSizesFor(profile)[0],
        size: profile.openaiSizes?.[0],
    };
    /** @type {Array<{label: string, values: object}>} */
    const cases = [{ label: 'defaults', values: base }];

    // 1. Every declared model value (not just the profile default).
    for (const m of profile.modelOptions ?? []) {
        cases.push({ label: `model=${m}`, values: { ...base, model: m } });
    }
    if (profile.model && !profile.modelOptions) {
        cases.push({ label: `model=${profile.model}`, values: { ...base, model: profile.model } });
    }

    // 2. Every declared version value.
    for (const v of profile.versionOptions ?? []) {
        cases.push({ label: `version=${v}`, values: { ...base, version: v } });
    }

    // 3. Every declared Flux 2 Klein parameter size.
    for (const mv of profile.modelVersionOptions ?? []) {
        cases.push({ label: `modelVersion=${mv}`, values: { ...base, modelVersion: mv } });
    }

    // 4. Every declared aspect ratio / image size / openai size.
    for (const r of profile.ratios ?? []) {
        cases.push({ label: `aspectRatio=${r}`, values: { ...base, aspectRatio: r } });
    }
    for (const s of imageSizesFor(profile)) {
        cases.push({ label: `imageSize=${s}`, values: { ...base, imageSize: s } });
    }
    for (const s of profile.openaiSizes ?? []) {
        cases.push({ label: `size=${s}`, values: { ...base, size: s } });
    }

    // 5. Every declared sampler / scheduler member (non-first members are where the
    //    previous single-payload check could never look).
    for (const s of profile.samplers ?? []) {
        cases.push({ label: `sampler=${s}`, values: { ...base, sampler: s } });
    }
    for (const s of profile.schedulers ?? []) {
        cases.push({ label: `scheduler=${s}`, values: { ...base, scheduler: s } });
    }

    // 6. Every extras[] enum member, both bool states, and the numeric extremes plus a
    //    FRACTIONAL probe for integer-typed extras (int32 deserialisation rejects 2.5).
    const flags = {};
    for (const extra of profile.extras ?? []) {
        for (const opt of extra.options ?? []) {
            flags[extra.key] = opt;
            cases.push({ label: `${extra.key}=${opt}`, values: { ...base, extraFlags: { ...flags } } });
        }
        if (extra.type === 'bool') {
            flags[extra.key] = true;
            cases.push({ label: `${extra.key}=true`, values: { ...base, extraFlags: { ...flags } } });
            flags[extra.key] = false;
            cases.push({ label: `${extra.key}=false`, values: { ...base, extraFlags: { ...flags } } });
        }
        if (extra.type === 'integer' || extra.type === 'number') {
            for (const v of [extra.min ?? -100, extra.max ?? 100, 2.5, -0.4]) {
                flags[extra.key] = v;
                cases.push({ label: `${extra.key}=${v}`, values: { ...base, extraFlags: { ...flags } } });
            }
        }
    }

    // 7. Numeric extremes AND out-of-range probes for the profile's own knobs. The
    //    out-of-range probes prove buildWorkflowInput() clamps rather than forwarding.
    if (profile.size === 'wh') {
        const min = profile.minSize ?? 64;
        const max = profile.maxSize ?? 2048;
        for (const [w, h] of [[min, min], [max, max], [min - 1, max + 1], [1, 1], [99999, 99999]]) {
            cases.push({ label: `size=${w}x${h}`, values: { ...base, width: w, height: h } });
        }
    }
    if (profile.guidance) {
        const min = profile.minGuidance ?? 0;
        const max = profile.maxGuidance ?? 30;
        for (const g of [min, max, min - 5, max + 5]) {
            cases.push({ label: `guidance=${g}`, values: { ...base, guidance: g } });
        }
    }
    if (profile.stepsField && profile.minSteps !== undefined) {
        for (const s of [profile.minSteps, profile.maxSteps, profile.minSteps - 1, profile.maxSteps + 1, 2.5]) {
            cases.push({ label: `steps=${s}`, values: { ...base, steps: s } });
        }
    }
    if (profile.count) {
        const max = profile.maxCount ?? 12;
        for (const q of [1, max, 0, max + 5]) {
            cases.push({ label: `quantity=${q}`, values: { ...base, quantity: q } });
        }
    }

    // 8. The nullableControls shape: both controls blank must OMIT the fields.
    if (profile.nullableControls) {
        cases.push({ label: 'steps="" cfg="" (nullable omission)', values: { ...base, steps: '', guidance: '' } });
    }

    // 9. A deliberately cleared negative prompt (preset restore of '' must not send one).
    cases.push({ label: 'negativePrompt="" (cleared)', values: { ...base, negativePrompt: '' } });

    // 10. HOSTILE values for every enum-shaped field. These are only reachable through
    //     a preset import or a corrupted settings file, which is exactly why they must
    //     not be trusted: they prove the value passes through pickEnum instead of being
    //     forwarded verbatim. Each one is expected to be REPLACED by a legal member.
    cases.push({ label: 'HOSTILE model/aspect/imageSize/size/modelVersion', values: { ...base, model: '__evil__', version: '__evil__', aspectRatio: '__evil__', imageSize: '__evil__', size: '__evil__', modelVersion: '__evil__', sampler: '__evil__', scheduler: '__evil__' } });

    // 11. HOSTILE LoRA list: a `__proto__` AIR (plain assignment would set the prototype
    //     and drop the entry) and duplicate AIRs (which must not silently count as two).
    if (profile.loraForm === 'map') {
        cases.push({
            label: 'HOSTILE loras: __proto__ key + duplicate AIR',
            values: { ...base, loras: [{ air: '__proto__', strength: 1 }, { air: sampleLoras(profile, 1)[0].air, strength: 0.5 }, { air: sampleLoras(profile, 1)[0].air, strength: 0.9 }] },
        });
    }

    // 12. HOSTILE extras: an out-of-enum enum member and a fractional value on an
    //     integer-typed extra must both be repaired, not forwarded.
    if (profile.extras?.length) {
        const hostile = {};
        for (const extra of profile.extras) {
            hostile[extra.key] = extra.type === 'enum' ? '__evil__' : (extra.type === 'integer' || extra.type === 'number' ? 2.5 : '__evil__');
        }
        cases.push({ label: 'HOSTILE extras (out-of-enum + fractional)', values: { ...base, extraFlags: hostile } });
    }

    return cases;
}

/** @type {Array<{profile: string, case: string, schema: string, problems: string[]}>} */
const failures = [];
const coveredSchemas = new Set();
let checkedCases = 0;

/** Profile defaults that contradict the spec default (quality, not a 400). */
const defaultProblems = [];

for (const profile of ENGINE_PROFILES) {
    const defaultMatches = schemasFor(profile);

    if (!defaultMatches.length) {
        failures.push({
            profile: profile.id, case: '-', schema: '-',
            problems: [`no schema matches engine=${profile.engine} ecosystem=${profile.ecosystem ?? '-'} model=${profile.model ?? '-'} version=${profile.version ?? '-'}`],
        });
        continue;
    }

    for (const testCase of buildCases(profile)) {
        checkedCases += 1;
        const input = buildWorkflowInput(profile, testCase.values);
        // Resolve per case: a non-default model/version points at a different schema.
        const matches = schemasFor(profile, { model: testCase.values.model, version: testCase.values.version });
        const perSchema = matches.map(s => ({
            s,
            errs: check(s, input, { requireable: s.hasOperation === !profile.omitOperation }),
        }));

        if (perSchema.some(x => x.errs.length === 0)) {
            for (const { s } of perSchema) {
                coveredSchemas.add(s.name);
            }
        } else {
            for (const { s, errs } of perSchema.slice(0, 2)) {
                failures.push({ profile: profile.id, case: testCase.label, schema: s.name, problems: errs });
            }
        }
    }
}

const ids = ENGINE_PROFILES.map(p => p.id);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

// Coverage is reported per candidate SCHEMA, i.e. per engine + ecosystem + model +
// version + discriminator leaf, not rolled up per ecosystem. The old roll-up reported
// "none uncovered" while flux2 pro/max/flex, WAN 2.5/2.7 and the sdxl-comfy variants
// were never validated as distinct targets.
const uncovered = candidates.filter(s => !coveredSchemas.has(s.name)).map(s => s.name);

// Cross-check the declared loraForm against what the schemas actually accept.
//
// The whole discriminator closure is considered, so a parent schema that has no
// `loras` field at all is ignored as long as at least one reachable schema declares the
// shape the profile claims. Only a CONCRETE conflicting shape is a defect: previously
// any `map|none` mixture was reported as a mismatch.
const loraProblems = [];
for (const profile of ENGINE_PROFILES) {
    const matches = schemasFor(profile);
    const concrete = new Set(matches
        .map(s => (s.loras == null ? null : (s.loras.type === 'array' ? 'array' : 'map')))
        .filter(Boolean));
    const declared = profile.loraForm ?? 'none';

    if (declared === 'none') {
        if (concrete.size) {
            loraProblems.push(`${profile.id}: declares no LoRA support but ${[...concrete].join('|')} schemas accept loras`);
        }
        continue;
    }

    if (!concrete.has(declared)) {
        loraProblems.push(`${profile.id}: loraForm="${declared}" but the matching schemas declare [${concrete.size ? [...concrete].join('|') : 'nothing'}]`);
    }

    const conflicting = [...concrete].filter(shape => shape !== declared);
    if (conflicting.length) {
        loraProblems.push(`${profile.id}: loraForm="${declared}" but ${conflicting.join('|')} schema(s) require a different shape`);
    }
}

// Internal consistency: the profile's declared bounds must agree with the schema's.
const boundProblems = [];
/**
 * Every schema reachable by any of the profile's selectable option values.
 * A `modelOptions` / `versionOptions` list spans several discriminator leaves, so
 * checking the option list against only the default variant's schema produces a false
 * alarm (and used to hide real ones).
 */
const variantsFor = (profile, key) => (profile[key] ?? [])
    .flatMap(value => schemasFor(profile, key === 'modelOptions' ? { model: value } : { version: value }));
/**
 * Schemas reachable by ONE specific option value. Needed because a discriminator leaf
 * declares only its own member, so option A must be compared against the leaf for A and
 * not against the leaf for B.
 */
const schemasForOption = (profile, key, value) => schemasFor(profile,
    key === 'modelOptions' ? { model: value } : key === 'versionOptions' ? { version: value } : {});
for (const profile of ENGINE_PROFILES) {
    const matches = schemasFor(profile);
const compare = (profileKey, schemaKey) => {
        const declared = profile[profileKey];
        for (const s of matches) {
            const f = s.fields[schemaKey];
            if (!f) continue;
            if (declared !== undefined && f.minimum !== undefined && declared < f.minimum) {
                boundProblems.push(`${profile.id}: ${profileKey}=${declared} is below the schema minimum:${f.minimum} (${s.name}.${schemaKey})`);
            }
            if (declared !== undefined && f.maximum !== undefined && declared > f.maximum) {
                boundProblems.push(`${profile.id}: ${profileKey}=${declared} is above the schema maximum:${f.maximum} (${s.name}.${schemaKey})`);
            }
        }
    };
    compare('minGuidance', profile.guidance);
    compare('maxGuidance', profile.guidance);
    compare('minSteps', profile.stepsField);
    compare('maxSteps', profile.stepsField);
    compare('minSize', 'width');
    compare('maxSize', 'width');
    compare('minSize', 'height');
    compare('maxSize', 'height');
    compare('maxCount', profile.count);

    // The declared default must itself be in range of the profile's own declared bounds.
    if (profile.guidance) {
        const v = profile.defaultGuidance;
        if (v !== undefined && (v < (profile.minGuidance ?? 0) || v > (profile.maxGuidance ?? 30))) {
            boundProblems.push(`${profile.id}: defaultGuidance=${v} is outside its own declared range`);
        }
    }
    for (const key of ['modelVersionOptions', 'versionOptions', 'modelOptions', 'openaiSizes', 'ratios', 'imageSizes']) {
        const declared = profile[key];
        if (!declared) continue;
        const schemaKey = key === 'modelVersionOptions' ? 'modelVersion'
            : key === 'versionOptions' ? 'version'
                : key === 'modelOptions' ? 'model'
                    : key === 'openaiSizes' ? 'size'
                        : key === 'ratios' ? 'aspectRatio' : 'imageSize';
        for (const option of declared) {
            for (const s of schemasForOption(profile, key, option)) {
                const f = s.fields[schemaKey];
                if (!f?.enum) continue;
                if (!f.enum.includes(option)) {
                    boundProblems.push(`${profile.id}: ${key} offers "${option}" which ${s.name}.${schemaKey} does not declare (enum:[${f.enum.join('|')}])`);
                }
            }
        }
    }
    for (const extra of profile.extras ?? []) {
        for (const s of matches) {
            const f = s.fields[extra.key];
            if (!f) continue;
            if (f.enum && (extra.options ?? []).filter(v => !f.enum.includes(v)).length) {
                boundProblems.push(`${profile.id}: extras "${extra.key}" offers [${(extra.options ?? []).filter(v => !f.enum.includes(v)).join(', ')}] which ${s.name}.${extra.key} does not declare (enum:[${f.enum.join('|')}])`);
            }
            if (f.type && extra.type === 'number' && (Array.isArray(f.type) ? f.type : [f.type]).includes('integer')) {
                boundProblems.push(`${profile.id}: extras "${extra.key}" is declared 'number' but ${s.name}.${extra.key} is integer — fractional values are a 400`);
            }
            if (f.minLength !== undefined && typeof extra.default === 'string' && extra.default.length > f.maxLength) {
                boundProblems.push(`${profile.id}: extras "${extra.key}" default is longer than maxLength:${f.maxLength}`);
            }
        }
    }
}

// Image-size bounds: imageSizesFor() must agree with the schema enum.
for (const profile of ENGINE_PROFILES) {
    if (profile.size !== 'imageSize') continue;
    for (const s of schemasFor(profile)) {
        const f = s.fields.imageSize;
        if (!f?.enum) continue;
        const extra = imageSizesFor(profile).filter(v => !f.enum.includes(v));
        if (extra.length) {
            boundProblems.push(`${profile.id}: imageSizesFor() offers [${extra.join(', ')}] which ${s.name}.imageSize does not declare (enum:[${f.enum.join('|')}])`);
        }
    }
}

// Prompt-guide coverage and profile self-consistency.
//
// These are not schema checks, but they are the checks the schema sweep structurally
// CANNOT make, and every one of them corresponds to a real defect: a guide asserting a
// fact the profile contradicts, guidance text advertising a knob the profile does not
// expose, a checkbox that renders checked but sends nothing, an enum select that
// persists `null`, a profile alias table with dead entries, a default that contradicts
// the spec default, and a nullable schema treated as always-present.
const guideProblems = [];
for (const profile of ENGINE_PROFILES) {
    const guide = promptGuideFor(profile);

    // One source of truth for the prompt shape.
    if (profile.promptStyle && guide.style !== profile.promptStyle) {
        guideProblems.push(`${profile.id}: effective style ${guide.style} !== profile.promptStyle ${profile.promptStyle}`);
    }
    // The FAMILY guide must agree too — otherwise the panel hint and the LLM instruction
    // (which is built from the profile) describe different prompt shapes. `mixed` is a
    // superset of both, so it is compatible with either concrete style.
    const stylesCompatible = (a, b) => a === b || a === 'mixed' || b === 'mixed';
    if (profile.promptStyle && !stylesCompatible(guide.familyStyle, profile.promptStyle)) {
        guideProblems.push(`${profile.id}: family guide "${guide.familyKey}" says style=${guide.familyStyle} but profile.promptStyle=${profile.promptStyle} (the panel and the LLM would disagree)`);
    }
    // A guide must not claim a control the profile does not expose.
    for (const knob of guide.knobs ?? []) {
        if (knob === 'cfg' && !profile.guidance) {
            guideProblems.push(`${profile.id}: guide "${guide.familyKey}" talks about CFG but the profile exposes no guidance field`);
        }
        if (knob === 'guidance' && !profile.guidance) {
            guideProblems.push(`${profile.id}: guide "${guide.familyKey}" talks about guidance but the profile exposes no guidance field`);
        }
        if (knob === 'steps' && !(profile.stepsField && profile.minSteps !== undefined)) {
            guideProblems.push(`${profile.id}: guide "${guide.familyKey}" gives step-count advice but the profile exposes no steps field`);
        }
        if (knob === 'negative' && !profile.negPrompt) {
            guideProblems.push(`${profile.id}: guide "${guide.familyKey}" suggests a negative prompt the schema does not accept`);
        }
    }
    // The fallback must not assert anything about an unknown family. `knobs` covers the
    // structural claims; this covers the prose, which is where the original defect was:
// "these commercial models take prose, not tags, and have no CFG/negative prompt" was
// shown to 13 profiles that all have both.
const FALLBACK = promptGuideFor({ id: '__none__', label: '', engine: '' });
if (/\bno\s+(cfg|negative|guidance|step)/i.test(FALLBACK.hint)) {
    guideProblems.push(`the generic fallback asserts facts about an undocumented family's controls: "${FALLBACK.hint.slice(0, 90)}"`);
}
if (!/no documented|unknown|no recipe/i.test(FALLBACK.hint)) {
    guideProblems.push(`the generic fallback must say the family is undocumented: "${FALLBACK.hint.slice(0, 90)}"`);
}
}

// Dead alias-table entries: a bucket no profile resolves to can never be consulted.
const aliases = airBucketAliases();
const claimed = new Set(ENGINE_PROFILES.flatMap(airBucketsFor));
for (const [ecosystem, buckets] of Object.entries(aliases)) {
    if (!ENGINE_PROFILES.some(p => p.ecosystem === ecosystem)) {
        guideProblems.push(`AIR_BUCKETS.${ecosystem} is dead: no profile declares ecosystem="${ecosystem}"`);
    }
    for (const bucket of buckets) {
        if (!claimed.has(bucket)) {
            guideProblems.push(`AIR bucket "${bucket}" (from AIR_BUCKETS.${ecosystem}) is claimed by nothing`);
        }
    }
}
for (const bucket of claimed) {
    if (!Object.values(aliases).some(list => list.includes(bucket))) {
        guideProblems.push(`AIR bucket "${bucket}" is reachable from a profile but absent from the alias table`);
    }
}

// Profile structural invariants that decide what the payload looks like.
const structuralProblems = [];
for (const profile of ENGINE_PROFILES) {
    const base = {
        ...VALUES,
        loras: sampleLoras(profile, 2),
        width: profile.defaultWidth ?? 1024,
        height: profile.defaultHeight ?? 1024,
        guidance: profile.defaultGuidance,
        steps: profile.defaultSteps,
        aspectRatio: profile.ratios?.[0] ?? '1:1',
        imageSize: imageSizesFor(profile)[0],
        size: profile.openaiSizes?.[0],
    };

    // Every declared extra must produce a value the profile itself calls legal.
    for (const extra of profile.extras ?? []) {
        // An enum control MUST declare a usable default. Without one the select could not
        // pick a value (`select.val(undefined)` is a jQuery GETTER), nothing was
        // auto-selected because the <select> was still detached, and `null` was
        // persisted and survived a reload.
        if (extra.type === 'enum') {
            if (!extra.options?.length) {
                structuralProblems.push(`${profile.id}: extras "${extra.key}" is an enum with no options`);
            }
            if (extra.default === undefined) {
                structuralProblems.push(`${profile.id}: extras "${extra.key}" is an enum with no default — the rendered select would have no selected value and the persisted flag would be null`);
            } else if (!extra.options.includes(extra.default)) {
                structuralProblems.push(`${profile.id}: extras "${extra.key}" default ${JSON.stringify(extra.default)} is not one of its own options [${extra.options.join('|')}]`);
            }
        }
        for (const state of extra.type === 'bool' ? [true, false] : (extra.options ?? [extra.default ?? 0])) {
            const input = buildWorkflowInput(profile, { ...base, extraFlags: { [extra.key]: state } });
            if (!(extra.key in input)) {
                structuralProblems.push(`${profile.id}: extras "${extra.key}" (${state}) is omitted from the payload entirely`);
                continue;
            }
            const sent = input[extra.key];
            if (extra.type === 'enum' && !(extra.options ?? []).includes(sent)) {
                structuralProblems.push(`${profile.id}: extras "${extra.key}" sent ${JSON.stringify(sent)}, which is not one of its own declared options [${(extra.options ?? []).join('|')}]`);
            }
            if ((extra.type === 'integer' || extra.type === 'number') && typeof sent === 'number' && !Number.isFinite(sent)) {
                structuralProblems.push(`${profile.id}: extras "${extra.key}" sent a non-finite number`);
            }
        }
        // Rendered-with-the-default means the default must reach the payload, and an
        // UNSET flag must still produce a legal value. `key in input` is not enough:
        // assigning `undefined` leaves the key present but makes JSON.stringify drop it,
        // which is exactly how a `select.val(undefined)` reached the wire as `null`.
        const withDefault = buildWorkflowInput(profile, { ...base, extraFlags: {} });
        const sent = withDefault[extra.key];
        const described = `${extra.key}=${JSON.stringify(sent)} (key ${extra.key in withDefault ? 'present' : 'absent'})`;
        if (!(extra.key in withDefault) || sent === undefined) {
            structuralProblems.push(`${profile.id}: extras "${extra.key}" renders from default=${JSON.stringify(extra.default)} but sends ${described} when unset — it would vanish on the wire`);
        } else if (extra.type === 'enum' && !(extra.options ?? []).includes(sent)) {
            structuralProblems.push(`${profile.id}: extras "${extra.key}" sends ${JSON.stringify(sent)} when unset, which is not one of its own options [${(extra.options ?? []).join('|')}]`);
        } else if (extra.type === 'bool' && sent !== (extra.default ?? false)) {
            structuralProblems.push(`${profile.id}: extras "${extra.key}" renders as ${extra.default ?? false} but sends ${JSON.stringify(sent)}`);
        } else if (extra.type === 'enum' && extra.default !== undefined && sent !== extra.default) {
            structuralProblems.push(`${profile.id}: extras "${extra.key}" default is ${JSON.stringify(extra.default)} but an unset flag sends ${JSON.stringify(sent)}`);
        }
    }

    // A LoRA that cannot be an AIR (notably "__proto__") must be REPORTED, not silently
    // dropped. Losing the entry quietly is the original defect; the warning is the
    // contract that the user is told.
    if (profile.loraForm) {
        const warnings = [];
        buildWorkflowInput(profile, { ...base, loras: [{ air: '__proto__', strength: 1 }], onWarning: m => warnings.push(m) });
        if (!warnings.length) {
            structuralProblems.push(`${profile.id}: a LoRA whose AIR is "__proto__" is dropped without any warning (it silently replaced the map prototype and was never sent)`);
        }
    }

    // profile.fixed must be copied, not aliased: mutating one payload must not corrupt
    // the profile for the next request.
    const first = buildWorkflowInput(profile, base);
    for (const [key, value] of Object.entries(profile.fixed ?? {})) {
        if (Array.isArray(value)) {
            if (first[key] === value) {
                structuralProblems.push(`${profile.id}: fixed "${key}" is aliased into the payload (mutating one result corrupts the profile)`);
            } else {
                first[key].push({ injected: true });
                const second = buildWorkflowInput(profile, base);
                if ((second[key]?.length ?? 0) !== value.length) {
                    structuralProblems.push(`${profile.id}: fixed "${key}" leaked across calls — a mutated payload changed the next one`);
                }
            }
        }
    }

    // A schema that declares steps / cfgScale as nullable with no default must be able
    // to OMIT them; otherwise the profile silently overrides the model's own recipe with
    // the clamped minimum (hidream-i1 used to send cfgScale: 0, steps: 1).
    for (const s of schemasFor(profile)) {
        for (const [schemaKey, profileKey] of [[profile.stepsField, 'stepsField'], [profile.guidance, 'guidance']]) {
            if (!schemaKey) continue;
            const f = s.fields[schemaKey];
            const nullable = Array.isArray(f?.type) && f.type.includes('null');
            if (nullable && f.default === undefined && profileKey && !profile.nullableControls) {
                structuralProblems.push(`${profile.id}: ${s.name}.${schemaKey} is nullable with no default but the profile has no nullableControls, so it always sends a clamped value`);
            }
        }
    }

    // The declared default must agree with the schema default where one is documented.
    // Not a 400, but shipping a default the spec contradicts is how "steps 20 vs 28"
    // and "guidance 2.5 vs 3.5" reached users.
    for (const s of schemasFor(profile)) {
        const pairs = [
            ['defaultSteps', profile.stepsField],
            ['defaultGuidance', profile.guidance],
            ['defaultWidth', profile.size === 'wh' ? 'width' : null],
            ['defaultHeight', profile.size === 'wh' ? 'height' : null],
        ];
        for (const [profileKey, schemaKey] of pairs) {
            const declared = profile[profileKey];
            if (declared === undefined || !schemaKey) continue;
            const specDefault = s.fields[schemaKey]?.default;
            if (specDefault !== undefined && specDefault !== null && declared !== specDefault) {
                defaultProblems.push(`${profile.id}: ${profileKey}=${declared} but ${s.name}.${schemaKey} documents default:${specDefault}`);
            }
        }
    }
}

console.log(`Profiles:   ${ENGINE_PROFILES.length}`);
console.log(`Engines:    ${new Set(ENGINE_PROFILES.map(p => p.engine)).size}`);
console.log(`Ecosystems: ${new Set(ENGINE_PROFILES.map(p => p.ecosystem).filter(Boolean)).size}`);
console.log(`Payloads checked: ${checkedCases} (${(checkedCases / ENGINE_PROFILES.length).toFixed(1)} per profile)`);
console.log(`LoRA-capable profiles: ${ENGINE_PROFILES.filter(p => p.loraForm === 'map').length} map, ${ENGINE_PROFILES.filter(p => p.loraForm === 'array').length} array, ${ENGINE_PROFILES.filter(p => !p.loraForm).length} without LoRA support`);
console.log(`Duplicates: ${duplicates.length ? duplicates.join(', ') : 'none'}`);
console.log(`Uncovered engine/ecosystem/model/version combinations: ${uncovered.length ? uncovered.join(', ') : 'none'}`);
console.log(`LoRA shape mismatches: ${loraProblems.length ? `\n  - ${loraProblems.join('\n  - ')}` : 'none'}`);
console.log(`Declared-bound mismatches: ${boundProblems.length ? `\n  - ${boundProblems.join('\n  - ')}` : 'none'}`);
console.log(`Profile structural problems: ${structuralProblems.length ? `\n  - ${structuralProblems.join('\n  - ')}` : 'none'}`);
console.log(`Prompt-guide problems: ${guideProblems.length ? `\n  - ${guideProblems.join('\n  - ')}` : 'none'}`);
console.log(`Declared-default vs spec-default mismatches: ${defaultProblems.length ? `\n  - ${defaultProblems.join('\n  - ')}` : 'none'}`);
console.log(`Failing payloads: ${failures.length}`);

if (failures.length) {
    console.error('\n--- FAILURES ---');
    for (const f of failures.slice(0, 60)) {
        console.error(`  x ${f.profile}  [${f.case}]  against ${f.schema}`);
        for (const p of f.problems) {
            console.error(`      ${p}`);
        }
    }
    if (failures.length > 60) {
        console.error(`  ... and ${failures.length - 60} more`);
    }
}

if (failures.length || duplicates.length || loraProblems.length || boundProblems.length
    || structuralProblems.length || guideProblems.length || defaultProblems.length) {
    console.error('\nFAILED');
    process.exit(1);
}

console.log('\nOK — every profile produces payloads the CivitAI imageGen schemas accept, across every declared enum member, numeric bound and nullable shape.');
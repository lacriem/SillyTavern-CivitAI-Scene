/**
 * CivitAI orchestration imageGen engine profiles.
 *
 * Every profile is derived from the official OpenAPI spec:
 * https://orchestration.civitai.com/v2/consumer/recipes/imageGen/openapi.yaml
 *
 * Each input schema in the spec sets `additionalProperties: false`, so a profile
 * describes exactly which fields may be sent. Anything the schema does not declare
 * fails the whole workflow with HTTP 400, hence the strict per-profile field list.
 *
 * Normalised field roles, so the extension code stays engine-agnostic:
 *   size        'wh' (width/height) | 'ratio' (aspectRatio) | 'imageSize' (named size)
 *               | 'openaiSize' (fixed size enum like 1024x1024)
 *   guidance    'cfgScale' (local engines) | 'guidanceScale' (hosted) | null
 *   steps       'steps' | 'numInferenceSteps' (flux2 dev/flex) | null
 *   count       'quantity' | 'numImages' (google) | null
 *   sampler     'sampleMethod' (sdcpp) | 'sampler' (comfy) | null
 *   scheduler   'schedule' (sdcpp) | 'scheduler' (comfy) | null
 *   checkpoint  Field carrying the base-weight AIR URN, or null when the engine has none
 *   promptStyle 'booru' for the anime/SD tag ecosystems, 'natural' for text-driven models
 */

/**
 * Per-ecosystem prompting guidance, taken from the official recipe pages under
 * https://developer.civitai.com/orchestration/recipes/.
 *
 * The two families genuinely need different prompt shapes and a tag prompt sent
 * to Flux (or a sentence sent to Pony) measurably underperforms, so the UI shows
 * the matching template instead of one generic textarea.
 *
 * `negative` is the starting point the recipe page itself recommends, or null
 * when the schema has no `negativePrompt` (or the engine ignores it at the
 * profile's default guidance — Z-Image Turbo at cfg 1, for example).
 *
 * `knobs` declares which sampler controls the guidance text talks about, so
 * validate-profiles.mjs can assert the advice matches the profile. Routing every
 * `wan*` profile to the Z-Image guide is what made it advertise "CFG 1, steps 8-12"
 * for a `guidanceScale` 1-10 knob that has no CFG and (for three of the four) no step
 * field at all.
 * @type {Record<string, {style: 'booru'|'natural'|'mixed', label: string, hint: string, example: string, negative: string|null, guidance: string, knobs?: string[]}>}
 */
const PROMPT_GUIDES = {
    anima: {
        style: 'booru',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Booru tags',
        hint: 'Anima wants comma-separated Booru tags, quality boosters first. Negative prompt strongly recommended.',
        example: 'masterpiece, best quality, 1girl, solo, portrait, looking at viewer, cinematic lighting, highly detailed',
        negative: 'worst quality, low quality, blurry, bad anatomy, deformed hands',
        guidance: 'CFG 3–5 (lower than SD1/SDXL), steps 25–35',
    },
    sdxl: {
        style: 'mixed',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Tags or natural language',
        hint: 'SDXL sits between SD1 tags and Flux prose — quality tags still help, full sentences work too. Negative prompt recommended.',
        example: 'masterpiece, best quality, 1girl, solo, landscape, sunset, cinematic lighting, highly detailed',
        negative: 'worst quality, low quality, blurry',
        guidance: 'CFG 6–8, steps 20–30 (LCM/Turbo: CFG 1–2, steps 4–8)',
    },
    sd1: {
        style: 'booru',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Booru tags',
        hint: 'SD1 is pure Booru tagging at 512. Lead with quality tags; negative prompt is expected, not optional.',
        example: 'masterpiece, best quality, 1girl, solo, white hair, garden, dappled sunlight',
        negative: 'worst quality, low quality, blurry, bad anatomy',
        guidance: 'CFG 7–9, steps 25–35, native 512',
    },
    ponyV7: {
        style: 'booru',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Score-tag Booru',
        hint: 'Pony/Illustrious expect Booru tags with a score prefix (score_9, score_8_up, score_7_up) to unlock quality.',
        example: 'score_9, score_8_up, score_7_up, 1girl, solo, detailed eyes, cinematic lighting',
        negative: 'score_4, score_3, worst quality, low quality, blurry, bad anatomy',
        guidance: 'CFG 5–7, steps 25–35',
    },
    hidream: {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'HiDream I1 follows prose. Pick the Variant first — the fast / dev / full tiers have very different step defaults and cost more.',
        example: 'A weathered lighthouse keeper on a rock jetty at dawn, thick fog rolling in, dramatic side light',
        negative: 'blurry, low quality, deformed hands, extra fingers',
        guidance: 'Leave steps and CFG blank to follow the variant defaults (16 / 1 for fast, 28 / 1 for dev, 50 / 5 for full).',
    },
    'hidream-o1': {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'HiDream O1 is an instruction-following editor — it follows prose commands literally and honours negative prompts.',
        example: 'Move the subject to the left, keep the background, change the lighting to golden hour',
        negative: 'blurry, low quality, watermark, text',
        guidance: 'CFG 1–5, steps 28–40. It ships its own checkpoint by default.',
    },
    chroma: {
        style: 'booru',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Booru tags',
        hint: 'Chroma is an open-weight anime model — it wants comma-separated Booru tags, and a negative prompt helps a lot.',
        example: 'masterpiece, best quality, 1girl, solo, sitting, school uniform, cherry blossoms, soft lighting, detailed eyes',
        negative: 'worst quality, low quality, blurry, bad anatomy, deformed hands',
        guidance: 'CFG 3–4, steps 20–30. This schema has no scheduler field.',
    },
    ideogram4: {
        style: 'natural',
        knobs: ['cfg', 'steps'],
        label: 'Natural language',
        hint: 'Ideogram 4 is strongest at legible text inside the image. Describe the scene in prose and say exactly what the text should read.',
        example: 'A chalkboard sign reading OPEN LATE, warm cafe interior, evening light, hand-lettered',
        negative: null,
        guidance: 'CFG 5–7, steps 12–20. This schema has no negative prompt field.',
    },
    boogu: {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'Boogu takes prose with explicit lighting and lens cues. Turbo is distilled — keep it short and it honours CFG 1.',
        example: 'A rain-soaked neon alley at night, reflections on the asphalt, 35mm, cinematic lighting',
        negative: 'blurry, low quality, watermark, text',
        guidance: 'Base: CFG 4, steps 20 · Turbo: CFG 1, steps 4–8.',
    },
    ernie: {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'ERNIE follows prose descriptions. Turbo is a distilled variant and should stay at a low step count.',
        example: 'An abandoned greenhouse reclaimed by ferns, shafts of light through broken glass, wide shot',
        negative: 'blurry, low quality, watermark, text',
        guidance: 'Standard: CFG 4, steps 20 · Turbo: CFG 1, steps 8.',
    },
    lens: {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'Lens is a photography-tuned model — describe it like a photographer: subject, focal length, light, mood.',
        example: 'Portrait of an elderly fisherman, 85mm f/1.4, window light, shallow depth of field, film grain',
        negative: 'blurry, low quality, deformed hands, watermark',
        guidance: 'Normal: CFG 4, steps 20 · Turbo: CFG 1, steps 4.',
    },
    ming: {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'Ming is a design/poster model. Be explicit about layout, palette and typography.',
        example: 'Minimalist travel poster, flat vector shapes, muted teal and sand palette, bold sans-serif headline reading KYOTO',
        negative: 'blurry, low quality, watermark, garbled text',
        guidance: 'CFG 1 is the intended setting — it is embedded guidance, steps 12.',
    },
    mageflow: {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'MageFlow follows prose. steps, cfgScale and quantity are mandatory on this schema, so they are always sent.',
        example: 'A tranquil mountain lake at first light, mist on the water, pine silhouettes, long exposure',
        negative: 'blurry, low quality, watermark, text',
        guidance: '4B: CFG 5, steps 20 · 4B Turbo: CFG 1, steps 4.',
    },
    flux1: {
        style: 'natural',
        knobs: ['cfg', 'steps'],
        label: 'Natural language',
        hint: 'Flux 1 follows prose. Describe subject, composition, lighting and lens. No negative prompt needed — guidance is embedded.',
        example: 'A photorealistic portrait of a woman with flowers in her hair, golden hour rim lighting, 85mm lens, shallow depth of field',
        negative: null,
        guidance: 'CFG 3.5–4 (higher values reduce variation), steps 20–30',
    },
    flux1Pro: {
        style: 'natural',
        knobs: [],
        label: 'Natural language',
        hint: 'Flux 1.1 Pro is a closed hosted model — it follows prose and exposes no sampler knobs at all. Ultra works from an aspect ratio instead of pixels.',
        example: 'A weathered lighthouse keeper on a rock jetty at dawn, thick fog rolling in, dramatic side light',
        negative: null,
        guidance: 'This model exposes no guidance or step control — only the values you can choose in the panel.',
    },
    flux2Klein: {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'Flux 2 Klein follows prose — lighting, composition and camera cues. Negative prompt is available on Klein only.',
        example: 'A cozy cabin in the woods at sunset, cinematic lighting, wide shot, 35mm',
        negative: 'blurry, low quality, watermark, text',
        guidance: 'CFG 4–6, steps 20 (Klein is efficient; 20 is usually plenty)',
    },
    flux2Dev: {
        style: 'natural',
        knobs: ['guidance', 'steps'],
        label: 'Natural language',
        hint: 'Flux 2 Dev follows prose with an embedded-guidance sampler. No negative prompt on this schema.',
        example: 'A majestic cat sitting on a throne, highly detailed, dramatic rim light, 8k',
        negative: null,
        guidance: 'guidance 2.5–4 (this is NOT the same scale as CFG), steps 28',
    },
    flux2Flex: {
        style: 'natural',
        knobs: ['guidance', 'steps'],
        label: 'Natural language',
        hint: 'Flux 2 Flex is the quality-first tier — it follows prose and holds detail, but it is the slowest and most expensive Flux 2 model.',
        example: 'A dense forest floor after rain, every fern and mushroom rendered, soft overcast light, macro detail',
        negative: null,
        guidance: 'guidance 1.5–100 (default 3.5), steps 2–50 (default 28)',
    },
    flux2ProMax: {
        style: 'natural',
        knobs: [],
        label: 'Natural language',
        hint: 'Flux 2 Pro and Max are closed hosted models — they follow prose and expose no guidance or step control at all.',
        example: 'A majestic cat sitting on a throne, highly detailed, dramatic rim light, 8k',
        negative: null,
        guidance: 'This model exposes no guidance or step control — only the values you can choose in the panel.',
    },
    krea2: {
        style: 'natural',
        knobs: [],
        label: 'Natural language',
        hint: 'Krea v2 responds best to literal natural-language descriptions. It has no CFG knob — creativity replaces it — and no negative prompt.',
        example: 'An epic fantasy battle scene with dragons, cinematic lighting, intricate details',
        negative: null,
        guidance: 'No CFG on this schema — use the creativity control instead',
    },
    zImage: {
        style: 'natural',
        knobs: ['cfg', 'steps', 'negative'],
        label: 'Natural language',
        hint: 'Z-Image wants prose with lighting/composition cues. Negative prompts only work on base — Turbo ignores them at CFG 1.',
        example: 'A photorealistic portrait of a woman with flowers in her hair, golden hour lighting',
        negative: 'blurry, low quality, deformed hands, bad anatomy, watermark, text',
        guidance: 'Turbo: CFG 1, steps 8–12 · Base: CFG 3–5, steps 20–30',
    },
qwen: {
        style: 'natural',
        label: 'Natural language',
        knobs: ['guidance', 'steps', 'negative'],
        hint: 'Qwen follows prose and is the pick when you need legible text or instruction-following rather than tags.',
        example: 'A cozy ramen stall in a rainy alley, steam rising, warm lantern light, hand-lettered menu board',
        negative: 'blurry, low quality, watermark, garbled text',
        guidance: 'guidance 2.5–4, steps 20–30',
    },
    qwenApi: {
        // The Alibaba-hosted endpoints expose neither a guidance nor a step control, so
        // they must not inherit the open-weight Qwen advice — same defect class as the
        // `wan*` profiles being routed to the Z-Image guide.
        style: 'natural',
        label: 'Natural language',
        knobs: ['negative'],
        hint: 'The hosted Qwen Image endpoints follow prose and are strongest on legible text. Use it when you want text rendered correctly.',
        example: 'A bookstore window sign reading "OPEN LATE", warm evening light, hand-lettered, reflections in the glass',
        negative: 'blurry, low quality, watermark, garbled text',
        guidance: 'This model exposes no guidance or step control — only the values you can choose in the panel.',
    },
    flux1Kontext: {
        style: 'natural',
        label: 'Natural language (editing)',
        knobs: ['guidance'],
        hint: 'Flux 1 Kontext edits an existing image from an instruction. Describe the change, and keep the original framing in mind — it does not invent a new scene. This schema has no negative prompt field.',
        example: 'Make it daytime with clear blue sky, same composition',
        negative: null,
        guidance: 'guidance 1–20 (3.5 is a good starting point). This model exposes no step count.',
    },
    wan: {
        style: 'natural',
        knobs: ['guidance'],
        label: 'Natural language',
        hint: 'WAN is a video-model-derived image generator — prose about subject, motion and camera framing works best.',
        example: 'A surfer riding a glassy wave at dawn, spray catching the light, low angle, cinematic',
        negative: 'blurry, low quality, watermark, text',
        guidance: 'guidance 1–10 (this is NOT the same scale as CFG). Only WAN 2.2 exposes a step count (2–40, default 27).',
    },
};

/**
 * Last-resort guidance for a profile with no entry in `PROMPT_GUIDES`.
 *
 * Deliberately says nothing about CFG, negative prompts or step counts: this
 * entry is reached exactly when the family is unknown, so asserting facts about
 * the schema would be a guess presented as documentation (which is how the
 * previous version of this constant ended up telling 13 profiles that have both
 * a CFG knob and a negative prompt that they have neither).
 */
const GENERIC_NATURAL = {
    style: 'natural',
    // Claims nothing: a guide that asserted a fact about an unknown family is how 13
    // profiles were told they have no CFG when they do.
    knobs: [],
    label: 'Natural language',
    hint: 'This family has no documented recipe page in the extension guide table, so no prompt-shape recommendation is made. Describe the subject, composition, lighting and camera in prose and press "Estimate cost" to confirm the settings are accepted.',
    example: 'A cozy cabin in the woods at sunset, cinematic lighting, wide shot, 35mm',
    negative: null,
    guidance: 'No family-specific recommendation — check the schema bounds shown on the controls.',
};

/**
 * Profiles that declare no `ecosystem` but still belong to a documented family —
 * the native `engine: "flux2"` / `engine: "krea"` paths select the variant with
 * `model` instead, so the ecosystem-based lookup alone cannot find them.
 * @type {Record<string, keyof typeof PROMPT_GUIDES>}
 */
const PROMPT_GUIDE_BY_ID = {
    'flux2klein-api': 'flux2Klein',
    'flux2dev-api': 'flux2Dev',
    'flux2flex-api': 'flux2Flex',
    'flux2pro-api': 'flux2ProMax',
    'flux2max-api': 'flux2ProMax',
    'flux1pro': 'flux1Pro',
    'flux1ultra': 'flux1Pro',
    'flux1kontext': 'flux1Kontext',
    'qwen-api': 'qwenApi',
    'qwen2-fal': 'qwenApi',
    krea: 'krea2',
    'krea2-fal': 'krea2',
    wan: 'wan',
    'wan-22-fal': 'wan',
    'wan-25-fal': 'wan',
    'wan-27-fal': 'wan',
};

/**
 * Prompting guidance for a profile.
 *
 * Resolved by profile id first (native engine+model paths carry no ecosystem),
 * then by ecosystem so every variant of a family shares one recommendation.
 *
 * `profile.promptStyle` is the single source of truth for the shape of the
 * prompt: it is returned here so the UI hint and the instruction sent to the LLM
 * can never disagree about whether a family wants booru tags or prose.
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 * @returns {{style: string, label: string, hint: string, example: string, negative: string|null, guidance: string}} Prompt guidance
 */
export function promptGuideFor(profile) {
    const key = PROMPT_GUIDE_BY_ID[profile.id] || profile.ecosystem;
    const guide = PROMPT_GUIDES[key] ?? GENERIC_NATURAL;
    // Never suggest a negative prompt the schema would reject.
    const negative = profile.negPrompt ? guide.negative : null;
    return {
        ...guide,
        // The effective style (what the LLM is told) and the family's own style. They
        // are equal by construction, and validate-profiles.mjs asserts it, because the
        // original bug was exactly a divergence here: chroma's family guide said
        // "Natural language" while the profile said booru, so the panel and the LLM
        // disagreed and the reply was run through the tag stripper.
        style: profile.promptStyle || guide.style,
        familyStyle: guide.style,
        familyKey: key,
        negative: negative,
    };
}

const SDCPP_SAMPLERS = ['euler', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'ipndm', 'ipndm_v', 'ddim_trailing', 'euler_a', 'lcm', 'res_multistep', 'res_2s', 'tcd', 'er_sde'];
const SDCPP_SCHEDULES = ['simple', 'discrete', 'karras', 'exponential', 'ays', 'bong_tangent', 'gits', 'sgm_uniform', 'smoothstep', 'kl_optimal', 'lcm'];
const COMFY_SAMPLERS = ['euler', 'euler_ancestral', 'euler_cfg_pp', 'euler_ancestral_cfg_pp', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_2s_ancestral_cfg_pp', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_cfg_pp', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu', 'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'lcm', 'ipndm', 'ipndm_v', 'deis', 'ddim', 'uni_pc', 'uni_pc_bh2', 'res_multistep', 'er_sde'];
const COMFY_SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'];
const WIDE_SD_SIZES = { minSize: 64, maxSize: 2048 };
const WAN_IMAGE_SIZES = ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'portrait_9_16', 'landscape_4_3', 'landscape_16_9'];

/** @type {Record<string, any>} */
const SDCPP = { sampler: 'sampleMethod', scheduler: 'schedule', samplers: SDCPP_SAMPLERS, schedulers: SDCPP_SCHEDULES };
/** @type {Record<string, any>} */
const COMFY = { sampler: 'sampler', scheduler: 'scheduler', samplers: COMFY_SAMPLERS, schedulers: COMFY_SCHEDULERS };

/**
 * Scheduler the SD1/SDXL recipes use.
 *
 * `SDCPP_SCHEDULES[0]` is `simple` (the enum order), so a "first legal member"
 * fallback picked that everywhere. `simple` is the default documented for Anima;
 * SD1 and SDXL default to `discrete`. Both are legal enum members, so this is a
 * quality difference rather than a 400.
 */
const SD_SD_SCHEDULER = 'discrete';

/**
 * @typedef {object} EngineProfile
 * @property {string} id Unique profile id
 * @property {string} label Human-readable name
 * @property {string} engine Value for the `engine` field
 * @property {string} [ecosystem] Value for the `ecosystem` field
 * @property {string} [model] Fixed `model` value
 * @property {string[]} [modelOptions] Selectable `model` values
 * @property {string} [versionField] Field carrying the version (`version` by default)
 * @property {string} [version] Default version value
 * @property {string[]} [versionOptions] Selectable version values
 * @property {string[]} [modelVersionOptions] Selectable Flux 2 Klein parameter sizes
 * @property {boolean} [needsCheckpoint] A checkpoint URN is mandatory
 * @property {string} [sampler] Sampler field name
 * @property {string[]} [samplers] Legal sampler values
 * @property {string} [defaultSampler] Sampler used when the engine has none saved
 * @property {string} [scheduler] Scheduler field name
 * @property {string[]} [schedulers] Legal scheduler values
 * @property {string} [defaultScheduler] Scheduler used when the engine has none saved
 * @property {string} [checkpoint] Field carrying the checkpoint URN
 * @property {string} [checkpointLabel] Label for the checkpoint input
 * @property {string} [checkpointTypes] AIR type segments to search
 * @property {Array<{field: string, label: string, required: boolean, types: string}>} [extraCheckpoints] Additional mandatory base-weight URNs (Flux 1 stack)
 * @property {boolean} [negPrompt] Engine accepts `negativePrompt`
 * @property {'wh'|'ratio'|'imageSize'|'openaiSize'} [size] How the output size is expressed
 * @property {number} [minSize] Minimum width/height
 * @property {number} [maxSize] Maximum width/height
 * @property {string[]} [ratios] Allowed `aspectRatio` values
 * @property {string[]} [imageSizes] Allowed `imageSize` values; defaults to WAN_IMAGE_SIZES when the profile declares `size: 'imageSize'`
 * @property {string[]} [openaiSizes] Allowed `size` values for the OpenAI engine
 * @property {string} [guidance] Field carrying the guidance value
 * @property {number} [minGuidance] Minimum guidance
 * @property {number} [maxGuidance] Maximum guidance
 * @property {number} [defaultGuidance] Default guidance
 * @property {string} [stepsField] Field carrying the step count
 * @property {number} [minSteps] Minimum steps
 * @property {number} [maxSteps] Maximum steps
 * @property {number} [defaultSteps] Default steps
 * @property {boolean} [nullableControls] Steps and CFG are `nullable` in this schema and are omitted entirely when the user leaves them blank
 * @property {string} [count] Field carrying the image count
 * @property {number} [maxCount] Maximum image count
 * @property {Array<{key: string, type: 'enum'|'bool'|'number'|'integer', label: string, options?: string[], default?: any, min?: number, max?: number}>} [extras] Extra simple controls declared by the schema
 * @property {Record<string, any>} [fixed] Constant fields that must always be sent (required arrays, provider flags)
 * @property {'map'|'array'} [loraForm] Shape the schema expects for `loras`; null/undefined means the schema has no LoRA support
 * @property {boolean} [seed] Engine accepts `seed`
 * @property {boolean} [omitOperation] The schema has no `operation` field at all
 * @property {number} [promptLimit] Maximum prompt length
 * @property {'booru'|'natural'} [promptStyle] Prompt style hint for the LLM
 * @property {string} [note] Extra note shown in the UI
 */

/** @type {EngineProfile[]} */
export const ENGINE_PROFILES = [
    // ---------------------------------------------------------------- Anima
    {
        id: 'anima', label: 'Anima — anime (CivitAI workers)', engine: 'sdcpp', ecosystem: 'anima',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 4,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 30,
        count: 'quantity', maxCount: 12, ...SDCPP,
        checkpoint: 'diffuserModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'booru',
        note: 'Built-in diffuser, no checkpoint needed. CFG 3-5, steps 25-35.',
    },
    {
        id: 'anima-comfy', label: 'Anima — anime (Comfy workers)', engine: 'comfy', ecosystem: 'anima',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 4,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 30,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffuserModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'booru',
    },

    // ------------------------------------------------------------- SDXL / SD1
    {
        id: 'sdxl', label: 'SDXL 1024 (CivitAI workers)', engine: 'sdcpp', ecosystem: 'sdxl',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 7,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...SDCPP, defaultScheduler: SD_SD_SCHEDULER,
        needsCheckpoint: true, checkpoint: 'model', checkpointTypes: 'checkpoint',
        seed: true, promptLimit: 10000, promptStyle: 'booru',
        note: 'Checkpoint is mandatory. CFG 5-8, steps 25-35.',
    },
    {
        id: 'sdxl-comfy', label: 'SDXL 1024 (Comfy workers)', engine: 'comfy', ecosystem: 'sdxl',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 7,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 30,
        count: 'quantity', maxCount: 12, ...COMFY,
        needsCheckpoint: true, checkpoint: 'model', checkpointTypes: 'checkpoint',
        seed: true, promptLimit: 10000, promptStyle: 'booru',
    },
    {
        id: 'sd1', label: 'SD 1.5 512 (CivitAI workers)', engine: 'sdcpp', ecosystem: 'sd1',
        negPrompt: true, size: 'wh', defaultWidth: 512, defaultHeight: 512, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 7,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...SDCPP, defaultScheduler: SD_SD_SCHEDULER,
        needsCheckpoint: true, checkpoint: 'model', checkpointTypes: 'checkpoint',
        seed: true, promptLimit: 10000, promptStyle: 'booru',
        note: 'Checkpoint is mandatory. Native resolution 512, CFG 7-9.',
    },
    {
        id: 'sd1-comfy', label: 'SD 1.5 512 (Comfy workers)', engine: 'comfy', ecosystem: 'sd1',
        negPrompt: true, size: 'wh', defaultWidth: 512, defaultHeight: 512, minSize: 64, maxSize: 1024,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 7,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 30,
        count: 'quantity', maxCount: 12, ...COMFY,
        needsCheckpoint: true, checkpoint: 'model', checkpointTypes: 'checkpoint',
        seed: true, promptLimit: 10000, promptStyle: 'booru',
    },
    {
        id: 'ponyv7', label: 'Pony V7 (Comfy workers)', engine: 'comfy', ecosystem: 'ponyV7',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 7,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 25,
        count: 'quantity', maxCount: 12, sampler: 'sampler', samplers: COMFY_SAMPLERS,
        needsCheckpoint: true, checkpoint: 'model', checkpointTypes: 'checkpoint',
        seed: true, promptLimit: 10000, promptStyle: 'booru',
        note: 'Checkpoint is mandatory. Pony score tags belong in the prompt, CFG 5-7.',
    },

    // ----------------------------------------------------------------- Flux
    {
        id: 'flux1', label: 'Flux 1 (CivitAI workers)', engine: 'sdcpp', ecosystem: 'flux1',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 832, maxSize: 1216,
        guidance: 'cfgScale', minGuidance: 1, maxGuidance: 20, defaultGuidance: 3.5,
        stepsField: 'steps', minSteps: 4, maxSteps: 50, defaultSteps: 28,
        count: 'quantity', maxCount: 4, ...SDCPP,
        needsCheckpoint: true, checkpoint: 'diffuserModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        extraCheckpoints: [
            { field: 'vaeModel', label: 'VAE', required: true, types: 'vae' },
            { field: 'clipLModel', label: 'CLIP-L', required: true, types: 'text_encoder,clip,clipL' },
            { field: 't5XXLModel', label: 'T5-XXL', required: true, types: 'text_encoder,clip,t5' },
        ],
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        note: 'Needs the whole Flux 1 stack: four AIR URNs for the weights, VAE, CLIP-L and T5-XXL.',
    },
    {
        id: 'flux1-comfy', label: 'Flux 1 (Comfy workers)', engine: 'comfy', ecosystem: 'flux1',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 3.5,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...COMFY,
        needsCheckpoint: true, checkpoint: 'model', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        note: 'This schema has no negativePrompt field — the prompt must be self-contained.',
    },
    {
        id: 'flux2klein', label: 'Flux 2 Klein (CivitAI workers)', engine: 'sdcpp', ecosystem: 'flux2Klein',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'cfgScale', minGuidance: 1, maxGuidance: 20, defaultGuidance: 5,
        stepsField: 'steps', minSteps: 4, maxSteps: 50, defaultSteps: 20,
        count: 'quantity', maxCount: 4, ...SDCPP,
        // The sdcpp schema has no 9b-kv member (it is ComfyUI-only), so offering it
        // here produced HTTP 500 with an empty body on every attempt.
        modelVersionOptions: ['4b', '4b-base', '9b', '9b-base'],
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        note: 'No checkpoint field in this schema. The sdcpp variant cannot select 9b-kv — that member only exists on the Comfy/API variants.',
    },
    {
        id: 'flux2klein-comfy', label: 'Flux 2 Klein (Comfy workers)', engine: 'comfy', ecosystem: 'flux2Klein',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'cfgScale', minGuidance: 1, maxGuidance: 20, defaultGuidance: 5,
        stepsField: 'steps', minSteps: 4, maxSteps: 50, defaultSteps: 20,
        count: 'quantity', maxCount: 4, ...COMFY,
        modelVersionOptions: ['4b', '4b-base', '9b', '9b-base', '9b-kv'],
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        note: 'No checkpoint field in this schema. This is the only open-weight variant that can select 9b-kv.',
    },
    {
        id: 'flux2dev', label: 'Flux 2 Dev (CivitAI workers)', engine: 'sdcpp', ecosystem: 'flux2Dev',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'cfgScale', minGuidance: 1, maxGuidance: 20, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 4, maxSteps: 50, defaultSteps: 20,
        count: 'quantity', maxCount: 4, ...SDCPP,
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        note: 'CFG is nearly inert for Flux 2 Dev — leave it at 1. No checkpoint field in this schema.',
    },
    {
        id: 'flux2dev-comfy', label: 'Flux 2 Dev (Comfy workers)', engine: 'comfy', ecosystem: 'flux2Dev',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'cfgScale', minGuidance: 1, maxGuidance: 20, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 4, maxSteps: 50, defaultSteps: 20,
        count: 'quantity', maxCount: 4, ...COMFY,
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        note: 'No checkpoint field in this schema.',
    },
    {
        id: 'flux2klein-api', label: 'Flux 2 Klein (CivitAI API)', engine: 'flux2', model: 'klein',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'cfgScale', minGuidance: 1, maxGuidance: 20, defaultGuidance: 5,
        stepsField: 'steps', minSteps: 4, maxSteps: 50, defaultSteps: 20,
        count: 'quantity', maxCount: 4, ...SDCPP,
        modelVersionOptions: ['4b', '4b-base', '9b', '9b-base', '9b-kv'],
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        extras: [{ key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false }],
    },
    {
        id: 'flux2dev-api', label: 'Flux 2 Dev (CivitAI API)', engine: 'flux2', model: 'dev',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'guidanceScale', minGuidance: 0, maxGuidance: 20, defaultGuidance: 2.5,
        stepsField: 'numInferenceSteps', minSteps: 4, maxSteps: 50, defaultSteps: 28,
        count: 'quantity', maxCount: 4,
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        extras: [{ key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false }],
    },
    {
        id: 'flux2flex-api', label: 'Flux 2 Flex (CivitAI API)', engine: 'flux2', model: 'flex',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'guidanceScale', minGuidance: 1.5, maxGuidance: 100, defaultGuidance: 3.5,
        stepsField: 'numInferenceSteps', minSteps: 2, maxSteps: 50, defaultSteps: 28,
        count: 'quantity', maxCount: 4,
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        extras: [{ key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false }],
    },
    {
        id: 'flux2pro-api', label: 'Flux 2 Pro (CivitAI API)', engine: 'flux2', model: 'pro',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        count: 'quantity', maxCount: 4,
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        extras: [{ key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false }],
    },
    {
        id: 'flux2max-api', label: 'Flux 2 Max (CivitAI API)', engine: 'flux2', model: 'max',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        count: 'quantity', maxCount: 4,
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        extras: [{ key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false }],
    },
    {
        id: 'flux1pro', label: 'Flux 1.1 Pro (CivitAI API)', engine: 'flux1-pro', model: 'pro',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 256, maxSize: 1440,
        count: 'quantity', maxCount: 4,
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        omitOperation: true,
    },
    {
        id: 'flux1ultra', label: 'Flux 1.1 Pro Ultra (CivitAI API)', engine: 'flux1-pro', model: 'ultra',
        size: 'ratio', ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', '9:21'],
        count: 'quantity', maxCount: 4,
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        omitOperation: true,
        extras: [{ key: 'raw', type: 'bool', label: 'Raw mode', default: false }],
        note: 'Aspect-ratio mode, no explicit pixel size.',
    },
    {
        id: 'flux1kontext', label: 'Flux 1 Kontext (image editing)', engine: 'flux1-kontext', model: 'pro',
        size: 'ratio', ratios: ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:21'],
        guidance: 'guidanceScale', minGuidance: 1, maxGuidance: 20, defaultGuidance: 3.5,
        count: 'quantity', maxCount: 4,
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        omitOperation: true,
        note: 'Editing model — it expects a source image, so it is rarely useful for scene generation.',
    },

    // --------------------------------------------------------- Qwen / Z-Image
    {
        id: 'qwen20b', label: 'Qwen-Image 20B (CivitAI workers)', engine: 'sdcpp', ecosystem: 'qwen', model: '20b',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 2.5,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...SDCPP,
        version: 'latest', versionOptions: ['latest', '2509', '2512'],
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        note: 'Strong at rendering text inside the image. No checkpoint field in this schema.',
    },
    {
        id: 'qwen20b-comfy', label: 'Qwen-Image 20B (Comfy workers)', engine: 'comfy', ecosystem: 'qwen', model: '20b',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 2.5,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...COMFY,
        version: 'latest', versionOptions: ['latest', '2509', '2512'],
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'qwen21', label: 'Qwen-Image 2.1 (Comfy workers)', engine: 'comfy', ecosystem: 'qwen', model: '2.1',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 25,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'qwen-api', label: 'Qwen Image (Alibaba API)', engine: 'qwen',
        modelOptions: ['3.0-pro', '2.0-pro', '2.0', 'max', 'plus'], model: '2.0',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 0, maxSize: 2048,
        count: 'quantity', maxCount: 6,
        seed: true, promptLimit: 5000, promptStyle: 'natural',
        extras: [
            { key: 'promptExtend', type: 'bool', label: 'Prompt extension', default: true },
            { key: 'watermark', type: 'bool', label: 'Watermark', default: false },
        ],
        note: 'Flat per-image price. Width and height are mandatory in this schema.',
    },
    {
        id: 'zimage-turbo', label: 'Z-Image Turbo (CivitAI workers)', engine: 'sdcpp', ecosystem: 'zImage', model: 'turbo',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 9,
        count: 'quantity', maxCount: 12, ...SDCPP,
        checkpoint: 'diffuserModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        note: 'Distilled turbo variant: 9 steps, CFG 1. LoRAs supported.',
    },
    {
        id: 'zimage-base', label: 'Z-Image Base (CivitAI workers)', engine: 'sdcpp', ecosystem: 'zImage', model: 'base',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 4,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...SDCPP,
        checkpoint: 'diffuserModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'zimage-turbo-comfy', label: 'Z-Image Turbo (Comfy workers)', engine: 'comfy', ecosystem: 'zImage', model: 'turbo',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 9,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffuserModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'zimage-base-comfy', label: 'Z-Image Base (Comfy workers)', engine: 'comfy', ecosystem: 'zImage', model: 'base',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 4,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffuserModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },

    // ----------------------------------------------------- Comfy ecosystems
    {
        id: 'chroma', label: 'Chroma (Comfy workers)', engine: 'comfy', ecosystem: 'chroma',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 3.5,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 28,
        count: 'quantity', maxCount: 12, sampler: 'sampler', samplers: COMFY_SAMPLERS,
        needsCheckpoint: true, checkpoint: 'model', checkpointTypes: 'checkpoint',
        seed: true, promptLimit: 10000, promptStyle: 'booru',
        note: 'Checkpoint is mandatory. This schema has no scheduler field.',
    },
    {
        id: 'hidream-i1', label: 'HiDream I1 (Comfy workers)', engine: 'comfy', ecosystem: 'hidream',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30,
        stepsField: 'steps', minSteps: 1, maxSteps: 150,
        nullableControls: true,
        count: 'quantity', maxCount: 12, sampler: 'sampler', samplers: COMFY_SAMPLERS,
        extras: [
            { key: 'variant', type: 'enum', label: 'Variant', options: ['fast', 'dev', 'full'], default: 'fast' },
            // The live enum is [fp8, fp16]; 'bf16' is a 400 ($.precision ... HiDreamI1Precision).
            { key: 'precision', type: 'enum', label: 'Precision', options: ['fp8', 'fp16'], default: 'fp8' },
        ],
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        note: 'Both controls are nullable in this schema — clear Steps and CFG to let the Variant pick its defaults (16 / 1 fast, 28 / 1 dev, 50 / 5 full).',
    },
    {
        id: 'hidream-o1', label: 'HiDream O1 (Comfy workers)', engine: 'comfy', ecosystem: 'hidream-o1',
        modelOptions: ['HiDream-O1-Image', 'HiDream-O1-Image-dev'], model: 'HiDream-O1-Image',
        negPrompt: true, size: 'wh', defaultWidth: 2048, defaultHeight: 2048, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 5,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 40,
        count: 'quantity', maxCount: 4,
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        note: 'The checkpointModel field has a spec default, so no checkpoint picker is needed.',
    },
    {
        id: 'ideogram4', label: 'Ideogram 4 (Comfy workers)', engine: 'comfy', ecosystem: 'ideogram4',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 7,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 12,
        count: 'quantity', maxCount: 12, sampler: 'sampler', samplers: COMFY_SAMPLERS,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        note: 'This schema has no negativePrompt field.',
    },
    {
        id: 'boogu-base', label: 'Boogu Base (Comfy workers)', engine: 'comfy', ecosystem: 'boogu', model: 'base',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 4,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'boogu-turbo', label: 'Boogu Turbo (Comfy workers)', engine: 'comfy', ecosystem: 'boogu', model: 'turbo',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 4,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'ernie', label: 'ERNIE (Comfy workers)', engine: 'comfy', ecosystem: 'ernie', model: 'ernie',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 4,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'ernie-turbo', label: 'ERNIE Turbo (Comfy workers)', engine: 'comfy', ecosystem: 'ernie', model: 'turbo',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 8,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'lens-normal', label: 'Lens Normal (Comfy workers)', engine: 'comfy', ecosystem: 'lens', model: 'normal',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 4,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'lens-turbo', label: 'Lens Turbo (Comfy workers)', engine: 'comfy', ecosystem: 'lens', model: 'turbo',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 4,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'ming', label: 'Ming Design (Comfy workers)', engine: 'comfy', ecosystem: 'ming', model: 'design',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 256, maxSize: 2048,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 12,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'krea2-raw', label: 'Krea v2 Raw (Comfy workers)', engine: 'comfy', ecosystem: 'krea2', model: 'raw',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 4,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'krea2-turbo', label: 'Krea v2 Turbo (Comfy workers)', engine: 'comfy', ecosystem: 'krea2', model: 'turbo',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, ...WIDE_SD_SIZES,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 8,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
    },
    {
        id: 'mageflow-4b', label: 'MageFlow 4B (Comfy workers)', engine: 'comfy', ecosystem: 'mageflow', model: '4b',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 5,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 20,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        note: 'steps, cfgScale and quantity are mandatory in this schema.',
    },
    {
        id: 'mageflow-4b-turbo', label: 'MageFlow 4B Turbo (Comfy workers)', engine: 'comfy', ecosystem: 'mageflow', model: '4b-turbo',
        negPrompt: true, size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 512, maxSize: 2048,
        guidance: 'cfgScale', minGuidance: 0, maxGuidance: 30, defaultGuidance: 1,
        stepsField: 'steps', minSteps: 1, maxSteps: 150, defaultSteps: 4,
        count: 'quantity', maxCount: 12, ...COMFY,
        checkpoint: 'diffusionModel', checkpointTypes: 'checkpoint,diffusion_model,diffusionmodel,unet',
        seed: true, promptLimit: 10000, promptStyle: 'natural',
        note: 'steps, cfgScale and quantity are mandatory in this schema.',
    },

    // ------------------------------------------------------------ Hosted APIs
    {
        id: 'gpt-image-15', label: 'OpenAI GPT-Image 1.5', engine: 'openai', model: 'gpt-image-1.5',
        size: 'openaiSize', openaiSizes: ['1024x1024', '1536x1024', '1024x1536'],
        count: 'quantity', maxCount: 4,
        promptLimit: 32000, promptStyle: 'natural',
        extras: [
            { key: 'quality', type: 'enum', label: 'Quality', options: ['low', 'medium', 'high'], default: 'high' },
            { key: 'background', type: 'enum', label: 'Background', options: ['auto', 'transparent', 'opaque'], default: 'auto' },
        ],
        note: 'Best at complex instructions and text rendering. No seed, no pixel size — only the fixed size enum.',
    },
    {
        id: 'gpt-image-2', label: 'OpenAI GPT-Image 2', engine: 'openai', model: 'gpt-image-2',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 256, maxSize: 3840,
        count: 'quantity', maxCount: 4,
        promptLimit: 32000, promptStyle: 'natural',
        extras: [{ key: 'quality', type: 'enum', label: 'Quality', options: ['low', 'medium', 'high'], default: 'high' }],
    },
    {
        id: 'gpt-image-25-sunburst', label: 'OpenAI GPT-Image 2.5 Sunburst', engine: 'openai', model: 'gpt-image-2.5-sunburst',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 256, maxSize: 3840,
        count: 'quantity', maxCount: 4,
        promptLimit: 32000, promptStyle: 'natural',
        extras: [{ key: 'quality', type: 'enum', label: 'Quality', options: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }],
    },
    {
        id: 'gpt-image-25-flare', label: 'OpenAI GPT-Image 2.5 Flare', engine: 'openai', model: 'gpt-image-2.5-flare',
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 256, maxSize: 3840,
        count: 'quantity', maxCount: 4,
        promptLimit: 32000, promptStyle: 'natural',
        extras: [{ key: 'quality', type: 'enum', label: 'Quality', options: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }],
    },
    {
        id: 'imagen4', label: 'Google Imagen 4', engine: 'google', model: 'imagen4',
        negPrompt: true, size: 'ratio', ratios: ['1:1', '16:9', '9:16', '3:4', '4:3'],
        count: 'numImages', maxCount: 4,
        seed: true, promptLimit: 1000, promptStyle: 'natural',
        omitOperation: true,
    },
    {
        id: 'nanobanana-pro', label: 'Google Nano Banana Pro', engine: 'google', model: 'nano-banana-pro',
        size: 'ratio', ratios: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'],
        count: 'numImages', maxCount: 4,
        promptLimit: 50000, promptStyle: 'natural',
        omitOperation: true,
        extras: [{ key: 'resolution', type: 'enum', label: 'Resolution', options: ['1K', '2K', '4K'], default: '1K' }],
        note: 'This schema has no seed field.',
    },
    {
        id: 'nanobanana-2', label: 'Google Nano Banana 2', engine: 'google', model: 'nano-banana-2',
        size: 'ratio', ratios: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'],
        count: 'numImages', maxCount: 4,
        seed: true, promptLimit: 50000, promptStyle: 'natural',
        omitOperation: true,
        extras: [
            { key: 'resolution', type: 'enum', label: 'Resolution', options: ['1K', '2K', '4K'], default: '1K' },
            { key: 'enableWebSearch', type: 'bool', label: 'Web search', default: false },
            { key: 'enableGoogleSearch', type: 'bool', label: 'Google search', default: false },
        ],
    },
    {
        id: 'nanobanana-2-lite', label: 'Google Nano Banana 2 Lite', engine: 'google', model: 'nano-banana-2-lite',
        size: 'ratio', ratios: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'],
        count: 'numImages', maxCount: 4,
        seed: true, promptLimit: 50000, promptStyle: 'natural',
        omitOperation: true,
        note: 'This schema has no resolution field.',
    },
    {
        id: 'gemini', label: 'Gemini 2.5 Flash Image', engine: 'gemini', model: '2.5-flash',
        size: 'none',
        count: 'quantity', maxCount: 4,
        promptLimit: 32000, promptStyle: 'natural',
        note: 'Very small schema: only prompt, model and quantity are accepted — no size, no seed.',
    },
    {
        id: 'seedream', label: 'Seedream (ByteDance)', engine: 'seedream',
        version: 'v4.5', versionOptions: ['v3', 'v4', 'v4.5', 'v5.0-lite', 'v5.0-pro'],
        size: 'wh', defaultWidth: 1024, defaultHeight: 1024, minSize: 256, maxSize: 4096,
        guidance: 'guidanceScale', minGuidance: 1, maxGuidance: 10, defaultGuidance: 2.5,
        count: 'quantity', maxCount: 12,
        seed: true, promptLimit: 32000, promptStyle: 'natural',
        omitOperation: true,
        extras: [{ key: 'enableSafetyChecker', type: 'bool', label: 'Safety checker', default: false }],
        note: 'This schema has no negativePrompt field.',
    },
    {
        id: 'grok-v1', label: 'Grok Imagine v1', engine: 'grok', version: 'v1.0',
        size: 'ratio', ratios: ['2:1', '20:9', '19.5:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:19.5', '9:20', '1:2'],
        count: 'quantity', maxCount: 4,
        promptLimit: 32000, promptStyle: 'natural',
        note: 'This schema has no seed field.',
    },
    {
        id: 'grok-v2', label: 'Grok Imagine v2', engine: 'grok', version: 'v2.0',
        size: 'ratio', ratios: ['2:1', '20:9', '19.5:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:19.5', '9:20', '1:2'],
        count: 'quantity', maxCount: 4,
        promptLimit: 32000, promptStyle: 'natural',
        extras: [
            { key: 'resolution', type: 'enum', label: 'Resolution', options: ['1k', '2k'], default: '2k' },
            { key: 'quality', type: 'enum', label: 'Quality', options: ['low', 'medium'], default: 'medium' },
        ],
    },
    {
        id: 'wan', label: 'WAN image (Alibaba API)', engine: 'wan', version: 'v2.2',
        negPrompt: true, size: 'imageSize',
        guidance: 'guidanceScale', minGuidance: 1, maxGuidance: 10, defaultGuidance: 3.5,
        count: 'quantity', maxCount: 10,
        seed: true, promptLimit: 32000, promptStyle: 'natural',
        omitOperation: true,
        extras: [
            { key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false },
            { key: 'enableSafetyChecker', type: 'bool', label: 'Safety checker', default: false },
        ],
        note: 'Uses named image sizes (square_hd, portrait_4_3, …) instead of pixels. Pick the FAL variant for the step-count controls.',
    },
    {
        id: 'wan-22-fal', label: 'WAN 2.2 (FAL)', engine: 'wan', version: 'v2.2',
        negPrompt: true, size: 'imageSize',
        guidance: 'guidanceScale', minGuidance: 1, maxGuidance: 10, defaultGuidance: 3.5,
        stepsField: 'steps', minSteps: 2, maxSteps: 40, defaultSteps: 27,
        count: 'quantity', maxCount: 10,
        seed: true, promptLimit: 32000, promptStyle: 'natural',
        omitOperation: true,
        fixed: { provider: 'fal' },
        extras: [
            { key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false },
            { key: 'enableSafetyChecker', type: 'bool', label: 'Safety checker', default: false },
            { key: 'acceleration', type: 'enum', label: 'Acceleration', options: ['none', 'fast', 'faster'], default: 'none' },
        ],
    },
    {
        id: 'wan-25-fal', label: 'WAN 2.5 (FAL)', engine: 'wan', version: 'v2.5',
        negPrompt: true, size: 'imageSize',
        guidance: 'guidanceScale', minGuidance: 1, maxGuidance: 10, defaultGuidance: 3.5,
        count: 'quantity', maxCount: 10,
        seed: true, promptLimit: 32000, promptStyle: 'natural',
        omitOperation: true,
        fixed: { provider: 'fal' },
        extras: [
            { key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false },
            { key: 'enableSafetyChecker', type: 'bool', label: 'Safety checker', default: false },
        ],
    },
    {
        id: 'wan-27-fal', label: 'WAN 2.7 (FAL)', engine: 'wan', version: 'v2.7',
        negPrompt: true, size: 'imageSize',
        guidance: 'guidanceScale', minGuidance: 1, maxGuidance: 10, defaultGuidance: 3.5,
        count: 'quantity', maxCount: 10,
        seed: true, promptLimit: 32000, promptStyle: 'natural',
        omitOperation: true,
        fixed: { provider: 'fal' },
        extras: [
            { key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: false },
            { key: 'enableSafetyChecker', type: 'bool', label: 'Safety checker', default: false },
            { key: 'usePro', type: 'bool', label: 'Use pro tier', default: false },
        ],
    },
    {
        id: 'krea', label: 'Krea v2 (Krea API)', engine: 'krea',
        modelOptions: ['krea2-medium', 'krea2-large', 'krea2-medium-turbo'], model: 'krea2-medium',
        size: 'ratio', ratios: ['1:1', '4:3', '3:2', '16:9', '2.35:1', '4:5', '2:3', '9:16'],
        count: 'quantity', maxCount: 10,
        seed: true, promptLimit: 5000, promptStyle: 'natural',
        fixed: { imageStyleReferences: [] },
        extras: [
            { key: 'creativity', type: 'enum', label: 'Creativity', options: ['raw', 'low', 'medium', 'high'], default: 'medium' },
            // The schema declares these as integer / int32 (-100..100). A fractional
            // value is a 400 ("could not be converted to System.Int32"), so the
            // type is integer and buildWorkflowInput rounds before clamping.
            { key: 'intensity', type: 'integer', label: 'Intensity', default: 0, min: -100, max: 100 },
            { key: 'complexity', type: 'integer', label: 'Complexity', default: 0, min: -100, max: 100 },
            { key: 'movement', type: 'integer', label: 'Movement', default: 0, min: -100, max: 100 },
        ],
        note: 'The spec marks imageStyleReferences as required, so an empty array is sent.',
    },
    {
        id: 'mai-image', label: 'MAI Image (FAL)', engine: 'fal', model: 'maiImage',
        size: 'ratio', ratios: ['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'],
        count: 'quantity', maxCount: 4,
        promptLimit: 5000, promptStyle: 'natural',
        note: 'Small schema: no negativePrompt, no guidance, no seed.',
    },
    {
        id: 'muse-image', label: 'MuseImage (FAL)', engine: 'fal', model: 'museImage',
        size: 'ratio', ratios: ['auto', '21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:21'],
        count: 'quantity', maxCount: 10,
        promptLimit: 32000, promptStyle: 'natural',
    },
    {
        id: 'reve', label: 'Reve (FAL)', engine: 'fal', model: 'reve',
        size: 'ratio', ratios: ['auto', '4:1', '3:1', '21:9', '2:1', '17:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '1:2', '1:3', '1:4'],
        count: 'quantity', maxCount: 10,
        promptLimit: 32000, promptStyle: 'natural',
    },
    {
        id: 'qwen2-fal', label: 'Qwen 2 (FAL)', engine: 'fal', model: 'qwen2',
        negPrompt: true, size: 'imageSize',
        // Qwen2FalImageGenInput.imageSize is a 6-value enum with no portrait_9_16.
        // Rendering the shared WAN list here offered an illegal value, and whatif
        // happily quoted the same price for it, so there was no signal at all.
        imageSizes: ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'],
        count: 'quantity', maxCount: 10,
        seed: true, promptLimit: 5000, promptStyle: 'natural',
        extras: [
            { key: 'enablePromptExpansion', type: 'bool', label: 'Prompt expansion', default: true },
            { key: 'enableSafetyChecker', type: 'bool', label: 'Safety checker', default: false },
        ],
    },
    {
        id: 'krea2-fal', label: 'Krea 2 (FAL)', engine: 'fal', model: 'krea2',
        size: 'ratio', ratios: ['1:1', '4:3', '3:2', '16:9', '2.35:1', '4:5', '2:3', '9:16'],
        count: 'quantity', maxCount: 10,
        seed: true, promptLimit: 5000, promptStyle: 'natural',
        fixed: { imageStyleReferences: [] },
        extras: [
            { key: 'size', type: 'enum', label: 'Size', options: ['medium', 'large'], default: 'medium' },
            { key: 'creativity', type: 'enum', label: 'Creativity', options: ['raw', 'low', 'medium', 'high'], default: 'medium' },
        ],
    },
];

/**
 * Profiles whose create schema has no `loras` field at all.
 *
 * These are the closed API models: CivitAI hosts the weights itself and the
 * request schema exposes no adapter hook, so a LoRA physically cannot be passed
 * even if the user owns one. Every remaining open-weight profile accepts LoRAs.
 */
const NO_LORA_PROFILES = new Set([
    'flux2flex-api', 'flux2pro-api', 'flux2max-api',
    'flux1pro', 'flux1ultra', 'flux1kontext',
    'qwen-api', 'qwen2-fal',
    'gpt-image-15', 'gpt-image-2', 'gpt-image-25-sunburst', 'gpt-image-25-flare',
    'imagen4', 'nanobanana-pro', 'nanobanana-2', 'nanobanana-2-lite', 'gemini', 'seedream',
    'grok-v1', 'grok-v2', 'krea', 'mai-image', 'muse-image', 'reve', 'krea2-fal',
]);

/**
 * Profiles that use the `{ air, strength }` array instead of the `{ air: weight }` map.
 * Only the WAN family and the open-weight Flux 2 Dev endpoint declare it that way.
 */
const ARRAY_LORA_PROFILES = new Set(['flux2dev-api']);

// `loras` is either a map of AIR -> weight or an array of { air, strength }.
for (const profile of ENGINE_PROFILES) {
    profile.loraForm = NO_LORA_PROFILES.has(profile.id)
        ? null
        : (ARRAY_LORA_PROFILES.has(profile.id) || profile.engine === 'wan' ? 'array' : 'map');
}

/**
 * Orchestration `ecosystem` value -> the AIR ecosystem buckets that can feed it.
 *
 * The AIR bucket is a coarser, differently named namespace: a Flux 2 Klein
 * checkpoint carries `urn:air:flux2:…` while its schema declares
 * `ecosystem: flux2Klein`, and Z-Image reports `zimageturbo` / `zimagebase`
 * against the `zImage` enum. Matching on the enum alone therefore misses models
 * that the schema would accept, which is what the fleet search filters on.
 */
const AIR_BUCKETS = {
    sdxl: ['sdxl', 'illustrious', 'pony'],
    sd1: ['sd1', 'sd15'],
    ponyV7: ['pony', 'illustrious'],
    anima: ['anima'],
    flux1: ['flux1'],
    flux2Klein: ['flux2'],
    flux2Dev: ['flux2'],
    zImage: ['zimage', 'zimageturbo', 'zimagebase'],
    qwen: ['qwen', 'qwen21'],
    hidream: ['hidream'],
    'hidream-o1': ['hidream-o1'],
    chroma: ['chroma'],
    boogu: ['boogu'],
    ernie: ['ernie'],
    lens: ['lens'],
    ming: ['ming'],
    mageflow: ['mageflow'],
    ideogram4: ['ideogram4'],
    krea2: ['krea2', 'fluxkrea'],
    // No profile declares `ecosystem: 'wan'`, so a `wan` bucket here could never be
    // consulted (every WAN profile runs on the native `wan` engine and has no AIR
    // picker at all) — it was dead weight that read as if it were wired up.
    //
    // `flux2Klein` and `flux2Dev` deliberately share one bucket: the AIR namespace
    // has a single `flux2` ecosystem, so there is no finer bucket to match on and
    // inventing one would silently hide every valid Klein/Dev checkpoint.
};

/**
 * AIR ecosystem buckets that may hold base weights for a profile.
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 * @returns {string[]} Lowercase bucket names, empty when the profile declares no ecosystem
 */
export function airBucketsFor(profile) {
    if (!profile.ecosystem) {
        return [];
    }
    return AIR_BUCKETS[profile.ecosystem] ?? [profile.ecosystem];
}

/**
 * The raw alias table, exported so validate-profiles.mjs can assert that every entry is
 * reachable from some profile. An alias no profile resolves to is dead weight that
 * reads as if it were wired up — which is exactly what `AIR_BUCKETS.wan` was.
 * @returns {Record<string, string[]>} Copy of the ecosystem -> AIR buckets table
 */
export function airBucketAliases() {
    return Object.fromEntries(Object.entries(AIR_BUCKETS).map(([k, v]) => [k, [...v]]));
}

/**
 * Checks whether an AIR URN can be fed to a profile.
 *
 * Returns `true` whenever the answer cannot be decided from the URN alone
 * (an `other` bucket, an ecosystem we have no mapping for, or a profile that
 * declares no ecosystem at all), so a custom resource is never discarded on a
 * guess — "Estimate cost" is the authoritative check.
 * @param {string} air AIR URN
 * @param {import('./engines.js').EngineProfile} profile Target profile
 * @returns {boolean} True when the URN is plausibly usable
 */
export function isAirCompatible(air, profile) {
    const match = /^(?:urn:)?air:([^:]+):/.exec(String(air || '').trim());

    if (!match || !profile.ecosystem) {
        return true;
    }

    const bucket = match[1].toLowerCase();

    if (bucket === 'other') {
        return true;
    }

    return airBucketsFor(profile).includes(bucket);
}

/** Profile used until the user picks another one. */
export const DEFAULT_ENGINE_ID = 'anima';

export { WAN_IMAGE_SIZES };

/**
 * The `imageSize` values a profile may offer.
 *
 * Most `imageSize` profiles accept the shared WAN list, but the FAL Qwen 2
 * endpoint declares its own 6-value enum without `portrait_9_16`, so the list has
 * to be per-profile rather than one shared constant.
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 * @returns {string[]} Legal `imageSize` values
 */
export function imageSizesFor(profile) {
    return profile.imageSizes ?? WAN_IMAGE_SIZES;
}

/**
 * Looks up a profile by id.
 * @param {string} id Profile id
 * @returns {EngineProfile} Profile, falling back to the default one
 */
export function getProfile(id) {
    return ENGINE_PROFILES.find(profile => profile.id === id)
        ?? ENGINE_PROFILES.find(profile => profile.id === DEFAULT_ENGINE_ID);
}

/**
 * Clips a prompt to the engine's length limit, if it has one.
 * @param {string} text Prompt text
 * @param {number} [limit] Maximum length
 * @returns {string} Trimmed prompt
 */
export function truncatePrompt(text, limit) {
    const value = String(text || '');
    return limit && value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Builds the `imageGen` step input for a profile.
 *
 * Pure and side-effect free on purpose: it takes the current parameter values and
 * returns a plain object, so the exact payload can be verified against the OpenAPI
 * schemas offline (see the repository's schema validation script) without a network
 * call or a live API key.
 *
 * @param {EngineProfile} profile Engine profile
 * @param {object} values Current parameter values
 * @param {string} values.prompt Positive prompt
 * @param {string} [values.negativePrompt] Negative prompt
 * @param {string} [values.model] Selected `model` value
 * @param {string} [values.version] Selected `version` value
 * @param {string} [values.modelVersion] Selected Flux 2 Klein parameter size
 * @param {string} [values.aspectRatio] Aspect ratio for ratio-based engines
 * @param {string} [values.imageSize] Named image size for WAN/Qwen-FAL
 * @param {string} [values.size] Fixed size string for the OpenAI engine
 * @param {number} [values.width] Pixel width
 * @param {number} [values.height] Pixel height
 * @param {number} [values.guidance] Guidance / CFG value
 * @param {number} [values.steps] Step count
 * @param {number} [values.quantity] Number of images
 * @param {string} [values.sampler] Sampler name
 * @param {string} [values.scheduler] Scheduler name
 * @param {number} [values.seed] Seed, negative means random
 * @param {string} [values.checkpoint] Base-weight AIR URN
 * @param {Record<string, string>} [values.extraCheckpoints] Extra mandatory AIR URNs by field
 * @param {Record<string, any>} [values.extraFlags] Extra control values by key
 * @param {Array<{air: string, strength?: number}>} [values.loras] LoRAs to apply, encoded per `profile.loraForm`
 * @param {(message: string) => void} [values.onWarning] Reports input that was silently dropped (e.g. duplicate LoRA AIRs)
 * @returns {Record<string, any>} imageGen input object
 */
export function buildWorkflowInput(profile, values) {
    const v = values ?? {};
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const pickEnum = (value, options, fallback) => (options?.includes(value) ? value : fallback);

    /** @type {Record<string, any>} */
    const input = {
        engine: profile.engine,
        prompt: truncatePrompt(v.prompt, profile.promptLimit),
    };

    // Some schemas (google, wan, seedream, flux1-pro, flux1-kontext) have no `operation` field.
    if (!profile.omitOperation) {
        input.operation = 'createImage';
    }

    if (profile.ecosystem) {
        input.ecosystem = profile.ecosystem;
    }

    if (profile.model) {
        input.model = pickEnum(String(v.model || profile.model), profile.modelOptions, profile.model);
    }

    if (profile.version) {
        const field = profile.versionField || 'version';
        input[field] = pickEnum(String(v.version || profile.version), profile.versionOptions, profile.version);
    }

    if (profile.negPrompt && v.negativePrompt) {
        input.negativePrompt = truncatePrompt(v.negativePrompt, profile.promptLimit);
    }

    switch (profile.size) {
        case 'none':
            break;
        case 'ratio':
            input.aspectRatio = pickEnum(String(v.aspectRatio || ''), profile.ratios, profile.ratios?.[0] || '1:1');
            break;
        case 'imageSize': {
            const sizes = profile.imageSizes || WAN_IMAGE_SIZES;
            input.imageSize = pickEnum(String(v.imageSize || ''), sizes, sizes[0]);
            break;
        }
        case 'openaiSize':
            // PickableSize: an out-of-enum value here is a 500, and the only path that
            // could produce one is an imported preset, so it must never bypass the list.
            input.size = pickEnum(String(v.size || ''), profile.openaiSizes, profile.openaiSizes?.[0] || '1024x1024');
            break;
        default: {
            const min = profile.minSize ?? 64;
            const max = profile.maxSize ?? 2048;
            const width = Math.round(Number(v.width) || profile.defaultWidth || 1024);
            const height = Math.round(Number(v.height) || profile.defaultHeight || 1024);
            input.width = clamp(width, min, max);
            input.height = clamp(height, min, max);
            break;
        }
    }

    // `nullableControls` schemas (HiDream I1) take steps/cfgScale as null and let the
    // Variant choose; sending 0/1 instead silently overrides a well-tuned recipe.
    const blank = value => value === '' || value === null || value === undefined;

    if (profile.guidance) {
        const min = profile.minGuidance ?? 0;
        const max = profile.maxGuidance ?? 30;
        const fallback = profile.defaultGuidance ?? min;

        if (profile.nullableControls && blank(v.guidance)) {
            // omitted on purpose
        } else {
            const value = Number(v.guidance);
            input[profile.guidance] = clamp(Number.isFinite(value) ? value : fallback, min, max);
        }
    }

    if (profile.stepsField && profile.minSteps !== undefined) {
        if (profile.nullableControls && blank(v.steps)) {
            // omitted on purpose
        } else {
            const fallback = profile.defaultSteps ?? profile.minSteps;
            const value = Number(v.steps);
            input[profile.stepsField] = clamp(Math.round(Number.isFinite(value) ? value : fallback), profile.minSteps, profile.maxSteps);
        }
    }

    if (profile.count) {
        input[profile.count] = clamp(Math.round(Number(v.quantity) || 1), 1, profile.maxCount ?? 12);
    }

    if (profile.sampler) {
        input[profile.sampler] = pickEnum(String(v.sampler || ''), profile.samplers, profile.samplers?.[0] || 'euler');
    }

    if (profile.scheduler) {
        input[profile.scheduler] = pickEnum(String(v.scheduler || ''), profile.schedulers, profile.defaultScheduler ?? profile.schedulers?.[0] ?? 'simple');
    }

    if (profile.seed && Number(v.seed) >= 0) {
        input.seed = Math.round(Number(v.seed));
    }

    if (profile.modelVersionOptions) {
        input.modelVersion = pickEnum(String(v.modelVersion || ''), profile.modelVersionOptions, profile.modelVersionOptions[0]);
    }

    const checkpoint = String(v.checkpoint || '').trim();
    if (profile.checkpoint && checkpoint) {
        input[profile.checkpoint] = checkpoint;
    }

    for (const extra of profile.extraCheckpoints ?? []) {
        const value = String(v.extraCheckpoints?.[extra.field] || '').trim();
        if (value) {
            input[extra.field] = value;
        }
    }

    for (const extra of profile.extras ?? []) {
        if (extra.type === 'bool') {
            // The stored value decides, default included: a checkbox rendered from
            // `extra.default` that never wrote it back sent no field at all.
            const stored = v.extraFlags?.[extra.key];
            const on = stored === undefined || stored === null ? extra.default ?? false : !!stored;
            input[extra.key] = !!on;
        } else if (extra.type === 'enum') {
            const options = extra.options ?? [];
            input[extra.key] = options.includes(v.extraFlags?.[extra.key]) ? v.extraFlags[extra.key] : (options.includes(extra.default) ? extra.default : options[0]);
        } else if (extra.type === 'integer') {
            // int32: a fractional value is rejected by the deserializer outright, so
            // round BEFORE clamping (clamping 2.5 against -100..100 left the fraction).
            const min = extra.min ?? -100;
            const max = extra.max ?? 100;
            const value = Math.round(Number(v.extraFlags?.[extra.key] ?? extra.default ?? 0));
            input[extra.key] = clamp(Number.isFinite(value) ? value : 0, min, max);
        } else if (extra.type === 'number') {
            const min = extra.min ?? -100;
            const max = extra.max ?? 100;
            const value = Number(v.extraFlags?.[extra.key] ?? extra.default ?? 0);
            input[extra.key] = clamp(Number.isFinite(value) ? value : 0, min, max);
        }
    }

    const loras = buildLoras(profile, v.loras, v.onWarning);
    if (loras !== undefined) {
        input.loras = loras;
    }

    // Deep copy: profile.fixed holds arrays (imageStyleReferences), and a shallow
    // assign would alias them into the payload, so a caller mutating the result
    // corrupted the profile for every later request.
    for (const [key, value] of Object.entries(profile.fixed ?? {})) {
        input[key] = Array.isArray(value) ? value.slice() : (value && typeof value === 'object' ? { ...value } : value);
    }

    return input;
}

/**
 * Renders the user's LoRA list in the shape the profile's schema expects.
 *
 * The API uses two different encodings for the same feature: most engines take
 * a `map<air, weight>`, while the WAN family and the Flux 2 Dev endpoint take
 * an array of `{ air, strength }` objects with `strength` capped at 4.
 *
 * The map form is built with `Object.defineProperty` rather than assignment so an
 * AIR literally called `__proto__` becomes an own enumerable key instead of
 * silently replacing the object's prototype (a plain assignment dropped the LoRA
 * entirely), and duplicate AIRs are reported through `onWarning` instead of
 * quietly collapsing last-wins while the status line still counted the rows.
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 * @param {Array<{air: string, strength?: number}>} [list] LoRAs chosen by the user
 * @param {(message: string) => void} [onWarning] Reports silently-dropped input
 * @returns {Record<string, number>|Array<{air: string, strength: number}>|undefined} Encoded LoRAs, or undefined when none apply
 */
function buildLoras(profile, list, onWarning) {
    if (!profile.loraForm || !Array.isArray(list)) {
        return undefined;
    }

    const entries = [];
    const seen = new Map();

    for (const item of list ?? []) {
        const air = String(item?.air || '').trim();

        if (!air) {
            continue;
        }

        // Every legal AIR carries at least one ":" (urn:air:<bucket>:<type>:<source>:<id>).
        // A key without one is not an AIR at all — and `__proto__` specifically is the
        // classic example: a plain assignment sets the object's prototype and the LoRA
        // disappears with no error at all. Reported and dropped rather than forwarded
        // as garbage. Checked before the map/array split, so it holds for both shapes.
        if (!air.includes(':')) {
            onWarning?.(`Ignored LoRA "${air}": that is not an AIR URN (expected something like urn:air:<ecosystem>:lora:civitai:<id>@<version>).`);
            continue;
        }

        entries.push({ air, strength: Number(item?.strength) });
    }

    if (!entries.length) {
        return undefined;
    }

    if (profile.loraForm === 'array') {
        return entries.map(({ air, strength }) => ({
            air: air,
            strength: Number.isFinite(strength) ? Math.min(4, Math.max(0, strength)) : 1,
        }));
    }

    const map = {};

    for (const { air, strength } of entries) {
        const weight = Number.isFinite(strength) ? Math.min(10, Math.max(-10, strength)) : 1;

        if (seen.has(air)) {
            onWarning?.(`Duplicate LoRA "${air}": only one entry per AIR can be sent, keeping strength ${weight} and dropping the earlier ${seen.get(air)}.`);
        }
        seen.set(air, weight);

        // Map form is an unconstrained number, but a negative weight is how a
        // "negative LoRA" is expressed, so keep the range symmetric.
        // defineProperty rather than assignment, so no key can ever reach the prototype.
        Object.defineProperty(map, air, { value: weight, writable: true, enumerable: true, configurable: true });
    }

    return map;
}

/**
 * Checks that the mandatory identifiers of a profile are present.
 * @param {EngineProfile} profile Engine profile
 * @param {Record<string, any>} values Current parameter values
 * @returns {string|null} Human-readable problem, or null when the profile can be submitted
 */
export function validateProfileValues(profile, values) {
    const checkpoint = String(values?.checkpoint || '').trim();

    if (profile.needsCheckpoint && !checkpoint) {
        return `${profile.label} needs a checkpoint. Pick one from the list above.`;
    }

    for (const extra of profile.extraCheckpoints ?? []) {
        if (extra.required && !String(values?.extraCheckpoints?.[extra.field] || '').trim()) {
            return `${profile.label} needs the ${extra.label} AIR URN. Fill in the ${extra.label} field.`;
        }
    }

    return null;
}

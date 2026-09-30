// SillyTavern's own modules are resolved at runtime, not by relative path: this
// extension can be served from public/scripts/extensions/<name>/ or from
// /scripts/extensions/third-party/<name>/, and a relative import 404s in the
// second layout. See st-modules.js.
import {
    eventSource,
    event_types,
    generateRaw,
    saveSettingsDebounced,
    substituteParamsExtended,
    systemUserName,
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    getMessageTimeStamp,
    humanizedDateTime,
    MEDIA_DISPLAY,
    MEDIA_SOURCE,
    MEDIA_TYPE,
    clamp,
    delay,
    getBase64Async,
    isTrueBoolean,
    saveBase64AsFile,
    SlashCommandParser,
    SlashCommand,
    ARGUMENT_TYPE,
    SlashCommandNamedArgument,
    commonEnumProviders,
    removeReasoningFromString,
    extensionKey as extensionName,
} from './st-modules.js';
import { ENGINE_PROFILES, airBucketsFor, buildWorkflowInput, getProfile, imageSizesFor, isAirCompatible, promptGuideFor, validateProfileValues } from './engines.js';

export { MODULE_NAME };

const MODULE_NAME = 'civitai_scene';
const ORCHESTRATION_URL = 'https://orchestration.civitai.com';
const SITE_API_URL = 'https://civitai.com/api/v1';
const SUBMIT_WAIT_SECONDS = 60;
// Real submissions use wait=0 so the workflowId comes back immediately and the
// job log can follow the lifecycle. whatif previews resolve instantly anyway.
const SUBMIT_WAIT_LIVE = 0;
const JOB_LOG_MAX_LINES = 400;
// Documented polling cadence: 2s, 5s, 10s, 15s, then 30s thereafter.
const POLL_SCHEDULE = [2000, 5000, 10000, 15000];
const POLL_MAX_DELAY = 30000;
const POLL_TIMEOUT = 10 * 60 * 1000;
const TERMINAL_STATUSES = ['succeeded', 'failed', 'expired', 'canceled'];
const BUSY_CLASS = 'cs-busy';
const BUSY_ICON = 'fa-circle-notch fa-spin';
const MODEL_CACHE_LIMIT = 300;
// The fleet list is global with no ecosystem filter, so the walk is bounded:
// ~12 pages is roughly 1200 resources and a few seconds, which is enough to
// reach even sparsely populated ecosystems.
const MODEL_PAGES_LIMIT = 12;
const MODEL_MATCH_TARGET = 200;
const MODEL_REQUEST_TIMEOUT_MS = 30000;
// `quantity` used to be missing here even though saveCurrentPreset() writes it, so a
// saved image count was never restored — and because applyPreset() is the only place
// that engine-scopes the recipe fields, quantity was not per-engine either.
const PRESET_FIELDS = ['width', 'height', 'steps', 'cfg_scale', 'quantity', 'prompt_prefix', 'negative_prompt'];
// Official Anima recipe defaults (developer.civitai.com/orchestration/recipes/anima)
const ANIMA_DEFAULT_PRESET = {
    width: 1024,
    height: 1024,
    steps: 30,
    cfg_scale: 4,
    prompt_prefix: 'masterpiece, best quality',
    negative_prompt: 'worst quality, low quality, blurry, bad anatomy, deformed hands',
};

const defaultInstruction = `You are an image prompt generator for an anime diffusion model. Analyze the provided roleplay scene and describe the most recent moment as a single image prompt.
Rules:
- Output ONLY the prompt: comma-separated English booru-style tags. No explanations, no quotes, no markdown.
- Focus on the LAST message of the scene: what is happening right now.
- Include: characters present, appearance (hair, eyes, outfit, body), expression, pose, action, environment, lighting, mood, camera framing.
- Start with quality tags: masterpiece, best quality.
- Maximum 60 tags.`;

const defaultSettings = {
    api_key: '',
    checkpoint_urn: '',
    model_cache: [],
    prompt_prefix: 'masterpiece, best quality',
    negative_prompt: 'worst quality, low quality, blurry, bad anatomy, deformed hands',
    width: 512,
    height: 512,
    steps: 20,
    cfg_scale: 4,
    seed: -1,
    scene_depth: 10,
    response_length: 1024,
    llm_instruction: defaultInstruction,
    allow_mature: true,
    yellow_only: true,
    auto_generate: false,
    model_presets: {},
    engine: 'anima',
    model_variant: '',
    model_version: '',
    model_version_variant: '',
    aspect_ratio: '1:1',
    image_size: 'square_hd',
    openai_size: '1024x1024',
    quantity: 1,
    sampler: '',
    scheduler: '',
    extra_checkpoints: {},
    extra_flags: {},
    loras: [],
    per_engine: {},
};

let isBusy = false;
/** What the single busy slot is currently running — decides what a second click means. @type {'generate'|'estimate'|'models'|null} */
let busyKind = null;
let abortController = null;

function settings() {
    return extension_settings.civitai_scene;
}
/**
 * Sanitizes the LLM reply for image generation.
 * Booru engines get a strict comma-separated tag list; natural-language engines
 * keep full sentences, so the tag-splitting rules must not run on them.
 * @param {string} str String to process
 * @param {'booru'|'natural'} [style] Prompt style expected by the engine
 * @returns {string} Processed reply
 */
function processReply(str, style = 'booru') {
    if (!str) {
        return '';
    }

    str = str.replaceAll('"', '');
    str = str.replaceAll('\u201c', '');
    str = str.replaceAll('\u201d', '');

    if (style !== 'booru') {
        return str
            .replaceAll('\r', '')
            .replace(/\n{2,}/g, '\n')
            .replace(/^\s*(prompt|answer|output)\s*:\s*/i, '')
            .trim();
    }

    str = str.replaceAll('\n', ', ');

    // Decompose, then delete the combining marks, then recompose.
    //
    // The old code normalised to NFD and fed the result straight to an ASCII filter, so
    // the *combining mark* of "café" was treated as a forbidden character and replaced
    // by a space ("café" -> "cafe " is harmless, but "naïve" -> "nai ve" was not), and
    // every CJK character was deleted outright. Deleting the marks first keeps the
    // base letter, and the filter below accepts any Unicode letter so non-Latin scripts
    // survive while punctuation and symbols still collapse to spaces.
    str = str.normalize('NFD').replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20f0\ufe20-\ufe2f]/g, '').normalize('NFC');

    // Strip out non-alphanumeric characters barring model syntax exceptions.
    // \p{L}/\p{N} keep letters and digits of every script (so CJK tags are not deleted).
    str = str.replace(/[^\p{L}\p{N}.,:_(){}<>[\]/\-'|#]+/gu, ' ');

    str = str.replace(/\s+/g, ' ');

    str = str.trim();

    str = str
        .split(',')
        .map(x => x.trim())
        .filter(x => x)
        .join(', ');

    return str;
}
function buildSceneText() {
    const context = getContext();
    const depth = clamp(Number(settings().scene_depth) || 10, 1, 100);
    return context.chat
        .slice(-depth)
        .filter(m => !m.is_system)
        .map(m => `${m.is_user ? (context.name1 || 'User') : (m.name || context.name2)}: ${m.mes}`)
        .join('\n');
}

/**
 * Recommended value for a field, derived straight from the profile definition.
 *
 * Used by `seedEngineRecipeDefaults()` when an engine is selected for the first
 * time, so a fresh engine starts from its own recipe values instead of inheriting
 * whatever the previously selected engine happened to leave in the settings.
 */
const PROFILE_FALLBACKS = {
    width: profile => profile.size === 'wh' ? (profile.defaultWidth ?? 1024) : undefined,
    height: profile => profile.size === 'wh' ? (profile.defaultHeight ?? 1024) : undefined,
    steps: profile => profile.defaultSteps,
    cfg_scale: profile => profile.defaultGuidance,
    quantity: () => 1,
};

/** Settings fields that belong to a single engine profile rather than the whole config. */
const RECIPE_FIELDS = ['width', 'height', 'steps', 'cfg_scale', 'quantity'];

/**
 * Reads a value saved for a specific engine profile, falling back to the shared one.
 * Lets every engine keep its own resolution / steps / CFG without extra UI clutter.
 * @param {string} key Setting name
 * @param {*} fallback Value used when nothing is stored for this engine
 * @returns {*} Stored value or the fallback
 */
function engineValue(key, fallback) {
    const s = settings();
    const stored = (s.per_engine || {})[s.engine] || {};
    // Per-engine value wins, then the shared setting. The profile defaults are applied
    // once, by seedEngineRecipeDefaults(), when the engine is first selected — reading
    // them here instead would reset an existing configuration on every load.
    return stored[key] ?? s[key] ?? fallback;
}

/**
 * Reads a value that only ever exists per engine.
 *
 * `sampler`, `scheduler`, `model`, `version` and `modelVersion` describe a choice
 * from an engine-specific enum, so inheriting another engine's value is always
 * wrong — a `dpm++2mv2` sampler is not an sdcpp enum member at all, and `9b-kv`
 * is a 500 on the sdcpp Klein schema. These therefore have no shared slot and no
 * cross-engine fallback.
 * @param {string} key Setting name
 * @param {*} [fallback] Value used when this engine has never been configured
 * @returns {*} Stored value or the fallback
 */
function perEngineOnly(key, fallback) {
    const s = settings();
    const stored = (s.per_engine || {})[s.engine] || {};
    return stored[key] ?? fallback;
}

/**
 * Seeds a freshly selected engine with its own recipe defaults.
 *
 * Without this, `s.width` / `s.steps` / `s.cfg_scale` are always populated by
 * `defaultSettings`, so the profile-defaults branch could never be reached and
 * every engine inherited the previous engine's numbers. Seeding on selection
 * fixes that while leaving two things alone: an engine the user already
 * configured (it has a per-engine entry, so nothing is written) and an engine
 * that is merely reloaded on page start (no selection event, so nothing is
 * written either).
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 */
function seedEngineRecipeDefaults(profile) {
    const s = settings();
    const perEngine = s.per_engine || (s.per_engine = {});

    if (perEngine[profile.id]) {
        return;
    }

    /** @type {Record<string, any>} */
    const seed = {};
    for (const key of RECIPE_FIELDS) {
        const value = PROFILE_FALLBACKS[key]?.(profile);
        if (value !== undefined) {
            seed[key] = value;
        }
    }

    if (Object.keys(seed).length) {
        perEngine[profile.id] = seed;
    }
}

/**
 * Saves a value for the current engine profile only.
 * @param {string} key Setting name
 * @param {*} value Value to store
 */
function setEngineValue(key, value) {
    const s = settings();
    const perEngine = s.per_engine || (s.per_engine = {});
    perEngine[s.engine] = perEngine[s.engine] || {};
    perEngine[s.engine][key] = value;
    s[key] = value;
}

/**
 * Asks the currently connected LLM to turn the last scene into an image prompt.
 * @returns {Promise<string>} Processed image prompt
 */
async function generateScenePrompt() {
    const context = getContext();

    if (!context.chat.some(m => !m.is_system)) {
        throw new Error('The chat is empty, nothing to analyze.');
    }

    const profile = getProfile(settings().engine);

    // promptGuideFor() is the single source of truth: it returns profile.promptStyle,
    // so the instruction sent to the LLM and the hint shown in the panel can never
    // disagree (chroma previously had the panel saying "Natural language" while the
    // LLM was told to emit booru tags and the reply was run through the tag stripper).
    const promptStyle = promptGuideFor(profile).style;
    const styleHint = promptStyle === 'booru'
        ? 'The selected engine expects comma-separated booru-style tags.'
        : 'The selected engine expects a flowing natural-language description, not tags.';

    const systemPrompt = substituteParamsExtended(settings().llm_instruction, {
        char: context.name2,
        user: context.name1,
    }) + `\n\n[${profile.label}] ${styleHint} Keep the answer under ${profile.promptLimit ?? 10000} characters.`;

    const raw = await generateRaw({
        prompt: buildSceneText(),
        systemPrompt: systemPrompt,
        responseLength: clamp(Number(settings().response_length) || 1024, 64, 4096),
    });

    // Reasoning models spend tokens on thinking before the actual answer.
    // Strip the reasoning block and give the model more headroom (responseLength above).
    const cleaned = removeReasoningFromString(String(raw));
    const prompt = processReply(cleaned, promptStyle);

    if (!prompt) {
        throw new Error('The LLM did not return a usable prompt (reasoning may have consumed all tokens). Increase "LLM response length" in the extension settings and try again.');
    }

    console.log(`[${extensionName}] LLM generated prompt: ${prompt}`);
    return prompt;
}

function civitaiHeaders() {
    return {
        'Authorization': `Bearer ${settings().api_key}`,
        'Content-Type': 'application/json',
    };
}

/**
 * Reads an error response body once, keeping the raw text as well as the JSON.
 *
 * `response.json()` was called with a `.catch(() => ({}))`, which threw away the body
 * whenever it was not JSON: a Cloudflare HTML 403 arrived as nothing at all, and two
 * of the observed HTTP 500s have a zero-length body, so the user only ever saw
 * `Unknown error`.
 * @param {Response} response Fetch response
 * @returns {Promise<{data: any, raw: string}>} Parsed JSON (or `{}`) and the raw text
 */
async function readApiBody(response) {
    const raw = await response.text().catch(() => '');

    if (!raw) {
        return { data: {}, raw: '' };
    }

    try {
        return { data: JSON.parse(raw), raw: raw };
    } catch {
        return { data: {}, raw: raw };
    }
}

/**
 * Server artefact that rides along with every RFC 7807 rejection.
 *
 * The endpoint validates `workflowTemplate` on the envelope as well as the step, so
 * every message carries `workflowTemplate: ["The workflowTemplate field is required."]`
 * next to the one that actually explains the problem.
 */
const WORKFLOW_TEMPLATE_ARTEFACT = 'The workflowTemplate field is required.';

/**
 * Extracts a human-readable message from an RFC 7807 ProblemDetails response.
 * Shape: { type, title, status, detail, errors: { "path.to.field": ["message", ...] } }
 * @param {object} data Parsed JSON body (may be empty)
 * @param {Response} [response] Fetch response for fallback status text
 * @returns {string} Combined error message
 */
function extractApiProblem(data, response) {
    const parts = [];

    if (data?.title) {
        parts.push(String(data.title));
    }

    if (data?.detail) {
        parts.push(String(data.detail));
    }

    if (Array.isArray(data?.errors)) {
        // Some rejections carry a flat array of messages instead of a path map.
        for (const entry of data.errors) {
            const text = typeof entry === 'string' ? entry : (entry?.message || JSON.stringify(entry));
            if (text && !parts.includes(text)) {
                parts.push(text);
            }
        }
    } else if (data?.errors && typeof data.errors === 'object') {
        for (const [path, messages] of Object.entries(data.errors)) {
            const list = Array.isArray(messages) ? messages : [messages];
            const text = list.map(m => String(m)).join('; ');
            // Hide the always-present workflowTemplate complaint so the actionable
            // message in the same body is actually visible.
            if (path === 'workflowTemplate' && list.every(m => String(m) === WORKFLOW_TEMPLATE_ARTEFACT)) {
                continue;
            }
            parts.push(`${path}: ${text}`);
        }
    }

    if (!parts.length) {
        const status = response?.status;
        const statusText = String(response?.statusText || '').trim();
        parts.push(String(data?.message || data?.error
            || (statusText && statusText.toLowerCase() !== 'internal server error' ? `${status} ${statusText}` : '')
            || (status ? `HTTP ${status} — the server returned no error detail for this request` : 'Unknown error')));
    }

    return parts.join(' | ');
}

/**
 * Builds a readable reason out of a failed workflow step (see "Errors & retries" docs).
 * @param {object} step Workflow step object
 * @returns {string} Failure description
 */
function describeStepFailure(step) {
    const parts = [];

    if (step?.reason) {
        parts.push(String(step.reason));
    }

    const jobs = Array.isArray(step?.jobs) ? step.jobs : [];
    // Prefer a job that actually failed or expired. The old predicate also matched any
    // job carrying a `reason`, so a SUCCEEDED sibling with a benign reason ("cache
    // hit") could win the `.find()` and hide the real failure sitting next to it.
    const job = jobs.find(j => j?.status === 'failed' || j?.status === 'expired' || j?.status === 'canceled')
        ?? jobs.find(j => j?.blockedReason)
        ?? jobs.find(j => j?.reason);

    if (job?.reason) {
        parts.push(`reason: ${job.reason}`);
    }

    if (job?.blockedReason) {
        parts.push(`blocked: ${job.blockedReason}`);
    }

    if (!parts.length && typeof step?.error === 'string' && step.error) {
        parts.push(step.error);
    }

    return parts.join('; ') || 'unknown failure';
}

/**
 * Shows a red error box in the result area and a toast.
 *
 * The result area and the job log belong to the *generation* pipeline. A failure
 * raised while the pipeline is idle — a bad API key on "Refresh checkpoints", a
 * failed CivitAI link lookup, an out-of-range preset — must not erase a finished
 * image or rewrite an already-priced job's summary to "Failed".
 * @param {string} message Error message
 * @param {boolean} [ownJob] True when the failure belongs to the in-flight generation
 */
function showError(message, ownJob = false) {
    console.error(`[${extensionName}]`, message);
    toastr.error(message.length > 200 ? `${message.slice(0, 200)}…` : message, 'CivitAI Scene', { timeOut: 10000, extendedTimeOut: 5000 });

    // Surface failures in the log too, so a rejected submission is not just a toast.
    if (ownJob && jobLog.lines.length) {
        appendJobLog(message.length > 300 ? `${message.slice(0, 300)}…` : message, 'error');
        setJobLogState('failed', 'error');
        setJobLogSummary(`Failed — ${message.length > 120 ? `${message.slice(0, 120)}…` : message}`);
        $('#cs_joblog_cancel').addClass('hidden');
    }

    if (ownJob) {
        const box = $('<div>').addClass('cs_error');
        const header = $('<div>').addClass('cs_error_header').append($('<i class="fa-solid fa-triangle-exclamation fa-fw"></i>')).append($('<span>').text('Error'));
        const body = $('<pre>').addClass('cs_error_body').text(message);
        box.append(header).append(body);
        $('#cs_result').empty().append(box);
    }

    setStatus(message.length > 140 ? `${message.slice(0, 140)}…` : message, 'error');
}

/**
 * Updates the progress status bar in the settings panel.
 * @param {string} text Status text (empty hides the bar)
 * @param {string} [kind] 'busy' | 'error' | 'success'
 */
function setStatus(text, kind = 'busy') {
    const bar = $('#cs_status').removeClass('cs_status_busy cs_status_error cs_status_success hidden').empty();

    if (!text) {
        bar.addClass('hidden');
        return;
    }

    if (kind === 'busy') {
        bar.append('<div class="cs_status_spinner"></div>');
        bar.append($('<span>').text(text));
        bar.append('<div class="cs_status_dots"><span></span><span></span><span></span></div>');
    } else {
        const icon = kind === 'success' ? 'fa-circle-check' : 'fa-triangle-exclamation';
        bar.append($(`<i class="fa-solid ${icon} fa-fw"></i>`));
        bar.append($('<span>').text(text));
    }

    bar.addClass(`cs_status_${kind}`);
}

/**
 * Live job log.
 *
 * The orchestration API is asynchronous: a submission returns a `workflowId`
 * and the job then walks `unassigned → preparing → scheduled → processing →
 * succeeded`. Nothing about that is visible from a spinner, so every transition,
 * the estimated progress, download progress and the final charge are recorded
 * here. `estimatedProgressRate` and `preparation` are documented as estimates,
 * so they are shown as such rather than as a hard countdown.
 */
const jobLog = {
    /** @type {string|null} */
    workflowId: null,
    /** @type {string|null} */
    lastStatus: null,
    /** @type {number} */
    lastProgress: -1,
    /** @type {string|null} */
    lastPreparation: null,
    /** @type {Set<string>} */
    lastWarnings: new Set(),
    /** @type {Set<string>} */
    lastJobReasons: new Set(),
    /** @type {number} */
    startedMs: 0,
    /** @type {Array<{at: number, kind: string, message: string}>} */
    lines: [],
};

/**
 * Formats a millisecond span as `1m 04s`.
 * @param {number} ms Duration in milliseconds
 * @returns {string} Human-readable duration
 */
function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/**
 * Formats seconds as `~2m 20s` or `~45s`.
 * @param {number} seconds Seconds
 * @returns {string} Human-readable duration
 */
function formatEta(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return total >= 60 ? `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s` : `${total}s`;
}

/**
 * Updates the badge in the log panel header.
 * @param {string} state Short state name
 * @param {string} [kind] Badge colour class
 */
function setJobLogState(state, kind = '') {
    const badge = $('#cs_joblog_state').text(state || 'idle');
    badge.attr('class', `cs_joblog_state${kind ? ` cs_joblog_${kind}` : ''}`);
}

/**
 * Sets the one-line summary above the log body.
 * @param {string} text Summary text
 */
function setJobLogSummary(text) {
    $('#cs_joblog_summary').text(text);
}

/**
 * Appends a timestamped line to the job log.
 * @param {string} message Message text
 * @param {string} [kind] 'info' | 'good' | 'warn' | 'error' | 'muted'
 */
function appendJobLog(message, kind = 'info') {
    const at = jobLog.startedMs ? Date.now() - jobLog.startedMs : 0;
    const stamp = jobLog.startedMs ? `[${formatDuration(at).padStart(7)}] ` : '';
    jobLog.lines.push({ at: Date.now(), kind: kind, message: String(message) });

    const line = $('<div>').addClass(`cs_joblog_line cs_joblog_line_${kind}`);
    line.append($('<span>').addClass('cs_joblog_time').text(stamp));
    line.append($('<span>').addClass('cs_joblog_msg').text(String(message)));

    const box = $('#cs_joblog');
    box.append(line);
    // Keep the tail visible; long polls would otherwise push progress off-screen.
    box.scrollTop(box[0]?.scrollHeight || 0);

    while (box.children().length > JOB_LOG_MAX_LINES) {
        box.children().first().remove();
        jobLog.lines.shift();
    }
}

/**
 * Renders a workflow snapshot into the log, logging only what actually changed.
 *
 * Called on every poll, so de-duplication matters: a 10-minute job polls for
 * minutes and must not produce hundreds of identical lines.
 * @param {object} workflow Workflow object from SubmitWorkflow / GetWorkflow
 */
function logWorkflow(workflow) {
    if (!workflow || typeof workflow !== 'object') {
        return;
    }

    if (workflow.id && workflow.id !== jobLog.workflowId) {
        jobLog.workflowId = workflow.id;
        appendJobLog(`Workflow accepted — id ${workflow.id}`, 'good');
    }

    const step = Array.isArray(workflow.steps) ? workflow.steps[0] : null;
    const status = String(workflow.status ?? 'unknown');
    const stepStatus = String(step?.status ?? '—');

    if (status !== jobLog.lastStatus) {
        jobLog.lastStatus = status;
        appendJobLog(`Workflow ${status}${stepStatus !== '—' ? ` · step ${stepStatus}` : ''}`, status === 'succeeded' ? 'good' : (status === 'failed' || status === 'expired' ? 'error' : 'info'));

        if (status === 'preparing') {
            appendJobLog('Worker is downloading the models this job needs — a cold checkpoint can take a while.', 'warn');
        }
    }

    const progress = Number(step?.estimatedProgressRate);

    if (Number.isFinite(progress)) {
        const pct = Math.round(progress * 100);
        // Log every 10% rather than every poll.
        const bucket = Math.floor(pct / 10) * 10;

        if (bucket !== jobLog.lastProgress) {
            jobLog.lastProgress = bucket;
            appendJobLog(`Progress ~${pct}% (estimated)`, 'muted');
        }
    }

    const preparation = step?.preparation;
    const gating = preparation?.resource ? String(preparation.resource) : '';

    if (gating) {
        const parts = [`${gating}`];

        if (Number.isFinite(Number(preparation.progress))) {
            parts.push(`downloading ${Math.round(Number(preparation.progress) * 100)}%`);
        }

        if (Number.isFinite(Number(preparation.queuePosition))) {
            parts.push(`queue #${preparation.queuePosition}`);
        }

        if (Number.isFinite(Number(preparation.etaSeconds))) {
            parts.push(`eta ${formatEta(preparation.etaSeconds)}`);
        }

        if (preparation.lane) {
            parts.push(`lane ${preparation.lane}`);
        }

        const line = parts.join(' · ');
        if (line !== jobLog.lastPreparation) {
            jobLog.lastPreparation = line;
            appendJobLog(`Preparing resource — ${line}`, 'warn');
        }
    }

    // Warnings and per-job reasons persist across polls (the server keeps sending the
    // whole step on every GET), so they need their own de-duplication — otherwise a
    // ten-minute job emitted the same line every poll and eventually pushed the
    // useful history past the 400-line trim.
    for (const warning of Array.isArray(step?.warnings) ? step.warnings : []) {
        const text = String(warning?.message || JSON.stringify(warning));
        if (jobLog.lastWarnings.has(text)) {
            continue;
        }
        jobLog.lastWarnings.add(text);
        appendJobLog(`Warning: ${text}`, 'warn');
    }

    for (const job of Array.isArray(step?.jobs) ? step.jobs : []) {
        const reason = job?.reason || job?.blockedReason;
        if (!reason) {
            continue;
        }
        const key = `${job?.id ?? '?'}|${job?.status ?? '?'}|${reason}`;
        if (jobLog.lastJobReasons.has(key)) {
            continue;
        }
        jobLog.lastJobReasons.add(key);
        appendJobLog(`Job ${job?.id ?? '?'} — ${job?.status ?? '?'}: ${reason}`, 'error');
    }
}

/**
 * The status the panel and the log should report for a workflow.
 *
 * A workflow can be `succeeded` while its single step is `failed`; gating only on
 * `workflow.status` logged "succeeded" and then threw, which reads as the extension
 * contradicting itself. Both must agree.
 * @param {object} workflow Workflow object
 * @returns {{ok: boolean, workflowStatus: string, stepStatus: string|null, label: string}} Outcome
 */
function workflowOutcome(workflow) {
    const step = Array.isArray(workflow?.steps) ? workflow.steps[0] : null;
    const workflowStatus = String(workflow?.status ?? 'unknown');
    const stepStatus = step?.status ? String(step.status) : null;
    const ok = workflowStatus === 'succeeded' && stepStatus !== 'failed'
        && stepStatus !== 'expired' && stepStatus !== 'canceled';
    const label = stepStatus && stepStatus !== workflowStatus
        ? `${workflowStatus} (step ${stepStatus})`
        : workflowStatus;
    return { ok: ok, workflowStatus: workflowStatus, stepStatus: stepStatus, label: label };
}

/**
 * Logs the final outcome of a job: timings, output count and what it cost.
 * @param {object} workflow Terminal workflow object
 * @param {boolean} [preview] True for a whatif, which never produces an image
 */
function logWorkflowResult(workflow, preview = false) {
    const step = Array.isArray(workflow?.steps) ? workflow.steps[0] : null;
    const images = Array.isArray(step?.output?.images) ? step.output.images.length : 0;
    const transactions = Array.isArray(workflow?.transactions?.list) ? workflow.transactions.list : [];
    const outcome = workflowOutcome(workflow);

    if (workflow?.createdAt && workflow?.completedAt) {
        appendJobLog(`Server timings: created ${workflow.createdAt} → completed ${workflow.completedAt}`, 'muted');
    }

    if (images && !preview) {
        appendJobLog(`Output: ${images} image(s)`, 'good');
    }

    for (const transaction of transactions) {
        const label = preview ? 'Would be charged' : 'Charged';
        appendJobLog(`${label}: ${transaction.amount} Buzz${transaction.accountType ? ` (${transaction.accountType})` : ''}`, preview ? 'muted' : (transaction.amount > 0 ? 'warn' : 'good'));
    }

    if (workflow?.nsfwLevel) {
        appendJobLog(`Classified: ${workflow.nsfwLevel}`, 'muted');
    }

    const failed = !preview && !outcome.ok;

    if (failed) {
        appendJobLog(`Failed (${outcome.label}): ${describeStepFailure(step)}`, 'error');
    }

    const bits = preview
        ? ['whatif — nothing was generated', transactions.length ? 'nothing was charged' : '']
        : [outcome.label, images ? `${images} image(s)` : 'no image'];

    if (jobLog.startedMs) {
        bits.push(`in ${formatDuration(Date.now() - jobLog.startedMs)}`);
    }

    setJobLogSummary(bits.filter(Boolean).join(' · '));

    if (!preview) {
        setJobLogState(outcome.label, failed ? 'error' : 'good');
    }
}

/**
 * Resets the job log for a new submission.
 * @param {boolean} [live] True for a real job (shows the cancel button)
 */
function resetJobLog(live = true) {
    jobLog.workflowId = null;
    jobLog.lastStatus = null;
    jobLog.lastProgress = -1;
    jobLog.lastPreparation = null;
    jobLog.lastWarnings = new Set();
    jobLog.lastJobReasons = new Set();
    jobLog.startedMs = Date.now();
    jobLog.lines = [];
    $('#cs_joblog').empty();
    // The panel is a <details>, which is opened by the `open` ATTRIBUTE. addClass()
    // added a class that no stylesheet rule matched, so the entire log stayed
    // collapsed (offsetHeight 0) until the user clicked it by hand.
    $('#cs_joblog_panel').prop('open', true).addClass('open');
    setJobLogSummary(live ? 'Submitting…' : 'Checking cost…');
    setJobLogState(live ? 'submitting' : 'estimate', 'busy');
    // A whatif never creates a job, so there is nothing to cancel.
    $('#cs_joblog_cancel').toggleClass('hidden', !live);
    appendJobLog(`POST /v2/consumer/workflows (wait=${live ? SUBMIT_WAIT_LIVE : SUBMIT_WAIT_SECONDS}, whatif=${!live}) — ${getProfile(settings().engine).label}`, 'muted');
}

/**
 * Cancels a running job server-side via DELETE /v2/consumer/workflows/{id}.
 * @returns {Promise<boolean>} True when the server accepted the cancel
 */
async function cancelWorkflowJob() {
    const workflowId = jobLog.workflowId;

    if (!workflowId) {
        toastr.info('No submitted job to cancel.', 'CivitAI Scene');
        return false;
    }

    try {
        const response = await fetch(`${ORCHESTRATION_URL}/v2/consumer/workflows/${workflowId}`, {
            method: 'DELETE',
            headers: civitaiHeaders(),
        });

        if (!response.ok) {
            const { data } = await readApiBody(response);
            throw new Error(`Cancel failed (${response.status}): ${extractApiProblem(data, response)}`);
        }

        appendJobLog(`DELETE /v2/consumer/workflows/${workflowId} — cancel requested`, 'warn');
        setJobLogSummary('Cancel requested — waiting for the server to confirm…');
        $('#cs_joblog_cancel').addClass('hidden');
        return true;
    } catch (err) {
        appendJobLog(String(err?.message || err), 'error');
        toastr.error(String(err?.message || err), 'CivitAI Scene');
        return false;
    }
}

/**
 * Shows an animated shimmer placeholder in the result area while generating.
 * @param {string} [promptText] Prompt to display inside the placeholder
 */
function showPlaceholder(promptText) {
    const box = $('<div>').addClass('cs_placeholder');
    const inner = $('<div>').addClass('cs_placeholder_inner');
    inner.append('<i class="fa-solid fa-image"></i>');
    inner.append($('<div>').addClass('cs_placeholder_label').text(promptText || 'Waiting for the scene analysis…'));
    box.append(inner);
    $('#cs_result').empty().append(box);
}

/**
 * Swaps the icon of every trigger button to a spinner while busy.
 * @param {boolean} busy Whether the pipeline is running
 */
function setBusyVisual(busy) {
    // #cs_estimate is in the list because "Estimate cost" is a long-running action too;
    // without it the button looked inert while the whatif was in flight, which is what
    // made a double-click look like it had been swallowed.
    const elements = [$('#cs_generate'), $('#civitai_scene_gen'), $('#cs_quick_gen'), $('#cs_estimate')];

    for (const element of elements) {
        const icon = element.is('.fa-solid') ? element : element.find('.fa-solid').first();
        if (!icon.length) {
            element.toggleClass(BUSY_CLASS, busy);
            continue;
        }

        if (busy) {
            // Snapshot BEFORE toggleClass adds BUSY_CLASS. On #cs_quick_gen the icon
            // *is* the element, so snapshotting afterwards stored a class string that
            // already contained `cs-busy` and restoring it left the wand pulsing
            // forever (animationName stayed "cs_pulse" after the first Estimate).
            if (!icon.data('cs_original_icon')) {
                icon.data('cs_original_icon', icon.attr('class'));
            }
            icon.attr('class', `fa-solid ${BUSY_ICON}`);
        } else if (icon.data('cs_original_icon')) {
            icon.attr('class', String(icon.data('cs_original_icon')));
            icon.removeData('cs_original_icon');
        }

        element.toggleClass(BUSY_CLASS, busy);
    }

    $('#cs_quick_gen').attr('title', busy ? 'Stop image generation' : 'Generate image from the scene (CivitAI)');
    $('#civitai_scene_gen').attr('title', busy ? 'Stop generation' : 'Generate an image from the current scene with CivitAI');
}

/**
 * Submits an imageGen workflow to the CivitAI orchestration API.
 * @param {boolean} whatif Validate and estimate the cost without executing
 * @param {string} prompt Image prompt
 * @param {string} negativePrompt Negative prompt
 * @param {AbortSignal} [signal] Abort signal
 * @returns {Promise<object>} Workflow object
 */
async function submitWorkflow(whatif, prompt, negativePrompt, signal) {
    const s = settings();

    if (!s.api_key) {
        throw new Error('CivitAI API key is not set. Open the CivitAI Scene Generator settings and paste your token.');
    }

    const profile = getProfile(s.engine);

    // These five are enum choices whose legal value set is engine-specific, so they
    // are read per engine only (see perEngineOnly). Reading the shared setting would
    // make every engine inherit the previous one's sampler / model / parameter size.
    const values = {
        prompt: prompt,
        negativePrompt: negativePrompt,
        model: perEngineOnly('model_variant'),
        version: perEngineOnly('model_version'),
        modelVersion: perEngineOnly('model_version_variant'),
        aspectRatio: s.aspect_ratio,
        imageSize: s.image_size,
        size: s.openai_size,
        width: engineValue('width', profile.defaultWidth ?? 1024),
        height: engineValue('height', profile.defaultHeight ?? 1024),
        guidance: engineValue('cfg_scale', profile.defaultGuidance ?? profile.minGuidance ?? 1),
        steps: engineValue('steps', profile.defaultSteps ?? profile.minSteps ?? 20),
        quantity: engineValue('quantity', 1),
        sampler: perEngineOnly('sampler'),
        scheduler: perEngineOnly('scheduler'),
        seed: s.seed,
        checkpoint: s.checkpoint_urn,
        extraCheckpoints: s.extra_checkpoints,
        extraFlags: s.extra_flags,
        loras: s.loras,
        onWarning: message => appendJobLog(message, 'warn'),
    };

    const problem = validateProfileValues(profile, values);
    if (problem) {
        throw new Error(problem);
    }

    const input = buildWorkflowInput(profile, values);

    /** @type {Record<string, any>} */
    const body = {
        steps: [{ $type: 'imageGen', input: input }],
        metadata: { source: 'sillytavern-civitai-scene', engine: profile.id },
    };

    if (s.yellow_only) {
        body.currencies = ['yellow'];
    }

    if (s.allow_mature) {
        body.allowMatureContent = true;
    }

    const wait = whatif ? SUBMIT_WAIT_SECONDS : SUBMIT_WAIT_LIVE;
    const response = await fetch(`${ORCHESTRATION_URL}/v2/consumer/workflows?wait=${wait}&whatif=${!!whatif}`, {
        method: 'POST',
        headers: civitaiHeaders(),
        body: JSON.stringify(body),
        signal: signal,
    });

    if (!response.ok) {
        const { data } = await readApiBody(response);
        throw new Error(`CivitAI API error (${response.status}): ${extractApiProblem(data, response)}`);
    }

    const data = await response.json();

    appendJobLog(`POST /v2/consumer/workflows → HTTP ${response.status} (wait=${wait})`, 'muted');

    for (const warning of Array.isArray(data?.steps?.[0]?.warnings) ? data.steps[0].warnings : []) {
        appendJobLog(`Warning: ${warning?.message || JSON.stringify(warning)}`, 'warn');
    }

    if (whatif) {
        const transaction = data?.transactions?.list?.[0];
        appendJobLog(`whatif estimate: ${transaction?.amount ?? data?.cost?.total ?? 'unknown'} Buzz (not executed)`, 'good');
    }

    logWorkflow(data);
    return data;
}

/**
 * `delay()` that also rejects when the signal aborts.
 *
 * The plain `await delay(POLL_MAX_DELAY)` was not abort-aware, so pressing Stop
 * while the loop sat in its 30-second tail left the UI frozen for up to 30s with
 * every button disabled.
 * @param {number} ms Milliseconds to wait
 * @param {AbortSignal} [signal] Abort signal
 * @returns {Promise<void>} Resolves on timeout, rejects on abort
 */
function abortableDelay(ms, signal) {
    if (!signal) {
        return delay(ms);
    }

    if (signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Polls a workflow until it reaches a terminal state.
 * @param {string} workflowId Workflow id
 * @param {AbortSignal} [signal] Abort signal
 * @param {Function} [onPoll] Progress callback (elapsedSeconds, workflow)
 * @returns {Promise<object>} Workflow object
 */
async function pollWorkflow(workflowId, signal, onPoll) {
    if (!workflowId) {
        throw new Error('Cannot follow a job without a workflow id.');
    }

    const start = Date.now();
    let attempt = 0;

    while (Date.now() - start < POLL_TIMEOUT) {
        const delayMs = attempt < POLL_SCHEDULE.length ? POLL_SCHEDULE[attempt] : POLL_MAX_DELAY;
        await abortableDelay(delayMs, signal);
        attempt += 1;

        const response = await fetch(`${ORCHESTRATION_URL}/v2/consumer/workflows/${workflowId}`, {
            method: 'GET',
            headers: civitaiHeaders(),
            signal: signal,
        });

        if (!response.ok) {
            const { data } = await readApiBody(response);
            throw new Error(`CivitAI API error (${response.status}): ${extractApiProblem(data, response)}`);
        }

        const workflow = await response.json();
        logWorkflow(workflow);

        if (typeof onPoll === 'function') {
            onPoll(Math.round((Date.now() - start) / 1000), workflow);
        }

        if (TERMINAL_STATUSES.includes(workflow.status)) {
            return workflow;
        }
    }

    appendJobLog(`Polling gave up after ${formatDuration(POLL_TIMEOUT)} — the job may still be running on the fleet.`, 'error');
    throw new Error('CivitAI generation timed out (10 minutes).');
}

/**
 * Generates an image using the CivitAI orchestration API (Anima ecosystem).
 * @param {string} prompt Image prompt
 * @param {string} negativePrompt Negative prompt
 * @param {AbortSignal} [signal] Abort signal
 * @param {Function} [onPoll] Progress callback (elapsedSeconds, workflow)
 * @returns {Promise<{format: string, data: string, url: string}>} Image data (base64) or fallback URL
 */
async function generateCivitaiImage(prompt, negativePrompt, signal, onPoll) {
    resetJobLog();
    let workflow = await submitWorkflow(false, prompt, negativePrompt, signal);

    if (!TERMINAL_STATUSES.includes(workflow?.status)) {
        // A 200 without an `id` used to be polled blindly at /workflows/undefined,
        // which 404s on every attempt and leaves Cancel dead.
        if (!workflow?.id) {
            throw new Error('CivitAI accepted the request but returned no workflow id, so the job cannot be tracked or cancelled.');
        }
        workflow = await pollWorkflow(workflow.id, signal, onPoll);
    }

    logWorkflowResult(workflow);
    $('#cs_joblog_cancel').addClass('hidden');

    const step = workflow?.steps?.[0];

    if (!workflowOutcome(workflow).ok) {
        throw new Error(`CivitAI generation failed (${workflowOutcome(workflow).label}): ${describeStepFailure(step)}`);
    }

    const image = step.output?.images?.[0];

    if (!image?.url) {
        throw new Error('CivitAI did not return an image URL.');
    }

    console.log(`[${extensionName}] Image URL: ${image.url}`);

    // Save the image locally like the SD extension does. If the download fails (CORS),
    // fall back to the signed remote URL directly.
    try {
        const imageResponse = await fetch(image.url, { signal: signal });
        if (!imageResponse.ok) {
            throw new Error(`HTTP ${imageResponse.status}`);
        }

        const blob = await imageResponse.blob();
        const mime = String(blob.type || '').toLowerCase();
        const format = mime.includes('png') ? 'png' : (mime.includes('webp') ? 'webp' : 'jpg');
        const dataUrl = await getBase64Async(blob);
        // /api/images/upload decodes the payload as raw base64, so strip the data URL prefix
        const data = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
        return { format: format, data: data, url: image.url };
    } catch (err) {
        console.warn(`[${extensionName}] Could not download the image, using the remote URL directly`, err);
        return { format: 'jpg', data: '', url: image.url };
    }
}

/**
 * Shows the generation result in the extension settings panel.
 * @param {string} url Image URL
 * @param {string} prompt Prompt used for the generation
 */
function showResult(url, prompt) {
    const resultElement = $('#cs_result').empty();
    const image = $('<img>')
        .attr('src', url)
        .addClass('cs_result_image')
        .on('click', () => window.open(url, '_blank'));
    const caption = $('<div>').addClass('cs_result_prompt').text(prompt);
    resultElement.append(image).append(caption);
}

/**
 * Adds the generated image into the chat as a new character message.
 * Mirrors the built-in SD extension sendMessage().
 * @param {string} prompt Image prompt
 * @param {string} image Image URL (local file or remote)
 */
async function sendMessage(prompt, image) {
    const context = getContext();
    const name = context.groupId ? systemUserName : context.name2;
    /** @type {MediaAttachment} */
    const mediaAttachment = {
        url: image,
        type: MEDIA_TYPE.IMAGE,
        title: prompt,
        source: MEDIA_SOURCE.GENERATED,
    };
    /** @type {ChatMessage} */
    const message = {
        name: name,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: prompt,
        extra: {
            media: [mediaAttachment],
            media_display: MEDIA_DISPLAY.GALLERY,
            media_index: 0,
            inline_image: false,
        },
    };
    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    setTimeout(() => context.scrollOnMediaLoad(), 100);
}

/**
 * Full pipeline: scene -> LLM prompt -> CivitAI image -> chat.
 * @param {string} initiator Where the generation was triggered from
 * @param {object} [options] Additional options
 * @param {string} [options.trigger] Raw prompt. When empty, the scene is analyzed by the LLM
 * @param {boolean} [options.quiet] Do not post the image into the chat
 * @returns {Promise<string>} Image URL, or an empty string on failure
 */
async function generatePicture(initiator, { trigger = '', quiet = false } = {}) {
    if (isBusy) {
        // The wand is a toggle, so a second click on a RUNNING generation stops it.
        // While a free, cancellable-whatif request or a fleet fetch is in flight,
        // aborting it produced a log that looked like a hang, so say what is going on
        // instead of silently killing it.
        if (busyKind !== 'generate') {
            toastr.info(busyKind === 'estimate'
                ? 'A free cost estimate is still running — wait for it to finish.'
                : 'The checkpoint list is still loading — wait for it to finish.', 'CivitAI Scene');
            return '';
        }

        if (abortController) {
            abortController.abort('Aborted by user');
        }
        return '';
    }

    const s = settings();

    if (!s.api_key) {
        toastr.error('CivitAI API key is not set. Open the CivitAI Scene Generator settings and paste your token.', 'CivitAI Scene');
        return '';
    }

    const profile = getProfile(s.engine);
    // One source of truth for the prompt shape: the same guide the panel hint uses.
    const promptStyle = promptGuideFor(profile).style;

    isBusy = true;
    busyKind = 'generate';
    abortController = new AbortController();
    const signal = abortController.signal;
    setBusyVisual(true);

    try {
        if (!trigger) {
            setStatus('Analyzing the scene with the LLM…');
            showPlaceholder('');
        }

        const prompt = trigger
            ? processReply(trigger, promptStyle)
            : await generateScenePrompt();

        if (!prompt) {
            throw new Error('The resulting prompt is empty.');
        }

        if (!trigger) {
            $('.cs_placeholder_label').text(prompt);
        }

        setStatus('Submitting to CivitAI…');

        const prefix = processReply(s.prompt_prefix, promptStyle);
        const prefixedPrompt = prefix ? `${prefix}, ${prompt}` : prompt;
        const negativePrompt = String(s.negative_prompt || '');
        const result = await generateCivitaiImage(prefixedPrompt, negativePrompt, signal, (elapsed) => {
            setStatus(`Generating image… ${elapsed}s`);
        });

        if (signal.aborted) {
            return '';
        }

        const context = getContext();
        const characterName = context.groupId ? systemUserName : (context.name2 || 'character');
        const filename = `${characterName}_${humanizedDateTime()}`;
        const url = result.data
            ? await saveBase64AsFile(result.data, characterName, filename, result.format)
            : result.url;

        if (!quiet) {
            await sendMessage(prefixedPrompt, url);
        }

        showResult(url, prefixedPrompt);
        setStatus('Image generated.', 'success');
        console.log(`[${extensionName}] Image generated: ${url}`);
        return url;
    } catch (err) {
        if (signal.aborted) {
            // Aborting the client fetch does NOT cancel the job: the workflow was
            // already accepted, so it ran to completion on the fleet and was billed
            // while the UI showed a stopped generation. Cancel it server-side.
            if (jobLog.workflowId) {
                const cancelled = await cancelWorkflowJob();
                appendJobLog(cancelled
                    ? `Cancelled server-side — workflow ${jobLog.workflowId} was deleted via DELETE, so it will not be charged.`
                    : `Could not cancel workflow ${jobLog.workflowId} — check the log; it may still run and be charged.`,
                cancelled ? 'good' : 'error');
            } else {
                appendJobLog('Stopped before the job was accepted — nothing was submitted, nothing was charged.', 'muted');
            }

            setJobLogState('canceled', 'warn');
            setJobLogSummary('Stopped by you — no image was produced.');
            $('#cs_joblog_cancel').addClass('hidden');
            toastr.info('Image generation stopped.', 'CivitAI Scene');
            setStatus('');
            return '';
        }

        showError(String(err?.message || err), true);
        return '';
    } finally {
        isBusy = false;
        busyKind = null;
        abortController = null;
        setBusyVisual(false);
    }
}

/**
 * Estimates the Buzz cost of the next generation without executing it (whatif).
 * Also validates the current settings (checkpoint URN etc.) — the whatif response
 * contains the exact API errors when something cannot be generated.
 */
async function estimateCost() {
    const s = settings();

    if (!s.api_key) {
        toastr.error('CivitAI API key is not set.', 'CivitAI Scene');
        return;
    }

    if (isBusy) {
        // Returning silently here read as a dead button.
        toastr.info(busyKind === 'generate'
            ? 'A generation is already running — press Stop first.'
            : 'Another request is already in flight.', 'CivitAI Scene');
        return;
    }

    isBusy = true;
    busyKind = 'estimate';
    abortController = new AbortController();
    const signal = abortController.signal;
    setBusyVisual(true);
    setStatus('Checking cost (whatif, free)…');

    // Everything that can throw has to be inside the try: a DOM throw before it left
    // `isBusy` true forever, which turned every button into a silent no-op until the
    // page was reloaded.
    try {
        resetJobLog(false);
        const workflow = await submitWorkflow(true, 'cost estimate', '', signal);
        setJobLogState('estimated', 'good');
        logWorkflowResult(workflow, true);
        const transaction = workflow?.transactions?.list?.[0];
        const amount = transaction?.amount ?? workflow?.cost?.total ?? 'unknown';
        const currency = transaction?.accountType ? ` ${transaction.accountType}` : '';
        const message = `Estimated cost: ${amount}${currency} Buzz per image.`;
        toastr.info(message, 'CivitAI Scene');
        setStatus(message, 'success');
        console.log(`[${extensionName}] ${message}`);
    } catch (err) {
        if (signal.aborted) {
            // The log used to stay frozen on "Checking cost…" with nothing to say so.
            appendJobLog('Cost check aborted by the user — nothing was charged (whatif is free).', 'warn');
            setJobLogState('canceled', 'warn');
            setJobLogSummary('Cost check stopped.');
            toastr.info('Cost check stopped. Nothing was charged.', 'CivitAI Scene');
            setStatus('');
        } else {
            showError(String(err?.message || err), true);
        }
    } finally {
        isBusy = false;
        busyKind = null;
        abortController = null;
        setBusyVisual(false);
    }
}

/**
 * Fetches the checkpoints usable by the selected engine profile.
 *
 * The fleet list is global and the endpoint offers no ecosystem filter, so the
 * AIR prefix has to be matched client side. Two details keep this fast:
 *
 * - `type` is a repeatable, OR'd parameter, so every base-weight type the
 *   profile accepts is fetched in a single stream instead of one stream each.
 *   Walking four separate cursors multiplied the request count by four.
 * - There is no way to know how deep an ecosystem sits, so the walk is bounded
 *   by a page cap, an early exit once enough matches are in, and a per-request
 *   timeout. Previously the cursor ran to its own limit with no timeout, which
 *   left the UI spinning on "Loading … checkpoints from the fleet…".
 *
 * Items carry a `canGenerate` flag telling whether cloud generation is enabled.
 * @param {AbortSignal} [signal] Abort signal
 * @param {(scanned: number, found: number) => void} [onProgress] Progress callback
 * @returns {Promise<Array>} ResourceInfo objects matching the current profile
 */
async function fetchLoadedModels(signal, onProgress) {
    const profile = getProfile(settings().engine);
    const types = String(profile.checkpointTypes || 'checkpoint').split(',').map(t => t.trim()).filter(Boolean);
    const buckets = airBucketsFor(profile);
    const prefixes = buckets.map(b => `urn:air:${b}:`);
    const byAir = new Map();
    let cursor = null;
    let scanned = 0;

    for (let page = 0; page < MODEL_PAGES_LIMIT; page++) {
        const params = new URLSearchParams({ view: 'loaded', take: '100', source: 'civitai' });
        for (const type of types) {
            params.append('type', type);
        }
        if (cursor) {
            params.set('cursor', cursor);
        }

        // The list must never be able to stall the refresh button indefinitely.
        const timeout = AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS);
        const response = await fetch(`${ORCHESTRATION_URL}/v2/resources?${params}`, {
            headers: civitaiHeaders(),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) {
            const { data } = await readApiBody(response);
            throw new Error(`Model list error (${response.status}): ${extractApiProblem(data, response)}`);
        }

        const data = await response.json();
        const items = Array.isArray(data.items) ? data.items : [];
        scanned += items.length;

        for (const item of items) {
            if (typeof item.air !== 'string' || byAir.has(item.air)) {
                continue;
            }
            // No ecosystem parameter exists on the endpoint, so the AIR bucket is
            // matched here — including the alternate names a profile accepts.
            const matches = !prefixes.length || prefixes.some(p => item.air.startsWith(p));
            if (matches) {
                byAir.set(item.air, item);
            }
        }

        onProgress?.(scanned, byAir.size);
        cursor = data.next;

        if (!cursor || byAir.size >= MODEL_MATCH_TARGET) {
            break;
        }
    }

    return [...byAir.values()];
}

/**
 * Calls the public CivitAI Site API.
 *
 * These endpoints need no token — the same key works, but it is not required,
 * so the "resolve a model link" feature stays usable before a key is pasted.
 * @param {string} path Path below /api/v1
 * @returns {Promise<any>} Parsed JSON body
 */
async function siteApiGet(path) {
    const response = await fetch(`${SITE_API_URL}${path}`, { headers: { Accept: 'application/json' } });
    const { data, raw } = await readApiBody(response);

    if (!response.ok) {
        const detail = data?.error || data?.message || (raw ? raw.slice(0, 200) : '') || extractApiProblem(data, response);
        throw new Error(`CivitAI replied ${response.status} for ${path}: ${detail}`);
    }

    return data;
}

/**
 * Recognises what the user pasted into a resource field.
 *
 * Accepted: an AIR URN, a model page link, a model-version page link, a bare
 * model id, `modelId@versionId`, or a bare id that may be either kind.
 * @param {string} text Raw user input
 * @returns {{kind: string, air?: string, modelId?: string, versionId?: string, id?: string}} Parsed reference
 */
export function parseCivitaiRef(text) {
    const raw = String(text ?? '').trim();

    if (!raw) {
        return { kind: 'empty' };
    }

    if (/^(?:urn:)?air:/i.test(raw)) {
        return { kind: 'air', air: raw };
    }

    // Reject any other URI scheme before the (deliberately unanchored, so a link inside
    // a sentence still works) host match below: `javascript:civitai.com/models/123` and
    // `data:civitai.com/models/123` both contain the host and were classified as CivitAI
    // model links before this guard ran.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
        return { kind: 'foreign' };
    }

    // civitai.com / civitai.red / green.civitai.com mirrors all work.
    // A `?modelVersionId=` query pins a SPECIFIC version; without honouring it, pasting
    // a link to one version silently resolved to the newest one.
    const fromUrl = /civitai\.[a-z.]+\/(?:api\/v1\/)?(models?|model-versions)\/(\d+)(?:[?&#][^\s]*?modelVersionId=(\d+))?/i.exec(raw);
    if (fromUrl) {
        if (fromUrl[3]) {
            return { kind: 'version', versionId: fromUrl[3] };
        }
        return fromUrl[1].toLowerCase().startsWith('model-versions')
            ? { kind: 'version', versionId: fromUrl[2] }
            : { kind: 'model', modelId: fromUrl[2] };
    }

    if (/^https?:\/\//i.test(raw)) {
        return { kind: 'foreign' };
    }

    const pair = /^(\d+)\s*@\s*(\d+)$/.exec(raw);
    if (pair) {
        return { kind: 'model', modelId: pair[1], versionId: pair[2] };
    }

    const bare = /^(\d+)$/.exec(raw);
    if (bare) {
        return { kind: 'either', id: bare[1] };
    }

    // Something like `sdxl:checkpoint:civitai:123@456` — the prefixes are optional.
    const loose = /^(?:[a-z0-9_-]+:){2,3}(?:[a-z0-9_.-]+@[a-z0-9_.-]+|[a-z0-9_.-]+)$/i.exec(raw);
    if (loose) {
        return { kind: 'air', air: `urn:air:${raw}` };
    }

    return { kind: 'foreign' };
}

/**
 * Chooses which version of a multi-version model to use.
 *
 * A merged checkpoint often ships one version per base model (the CivitAI
 * SNOFS merge, for example, has both Krea 2 and Flux.2 Klein versions), so the
 * newest version that the cloud can actually run wins.
 * @param {any} model Model payload from /models/{id}
 * @param {string} [wantedVersionId] Explicit version the user asked for
 * @returns {any} Chosen modelVersion entry
 */
function pickModelVersion(model, wantedVersionId) {
    const versions = Array.isArray(model?.modelVersions) ? model.modelVersions : [];

    if (!versions.length) {
        throw new Error(`"${model?.name || model?.id}" has no published versions.`);
    }

    if (wantedVersionId) {
        const wanted = versions.find(v => String(v.id) === String(wantedVersionId));
        if (!wanted) {
            throw new Error(`Version ${wantedVersionId} is not published for "${model.name}".`);
        }
        return wanted;
    }

    const generatable = versions.filter(v => v.supportsGeneration);
    const pool = generatable.length ? generatable : versions;
    return pool.slice().sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))[0];
}

/**
 * Resolves a model version id into its canonical AIR URN.
 * @param {string} versionId Model version id
 * @returns {Promise<{air: string, name: string, versionName: string}>} Resolved resource
 */
async function resolveModelVersion(versionId) {
    const version = await siteApiGet(`/model-versions/${versionId}`);

    if (typeof version?.air !== 'string' || !version.air) {
        throw new Error(`CivitAI did not return an AIR for version ${versionId}.`);
    }

    return {
        air: version.air,
        name: version.modelName || `Model ${version.modelId ?? versionId}`,
        versionName: version.name || '',
    };
}

/**
 * Turns anything the user pasted into a usable AIR URN.
 * @param {string} text Model link, id, `modelId@versionId` or an AIR URN
 * @returns {Promise<{air: string, name: string, versionName: string}>} Resolved resource
 */
async function resolveCivitaiAir(text) {
    const ref = parseCivitaiRef(text);

    if (ref.kind === 'empty') {
        throw new Error('Paste a CivitAI model link, an id, or an AIR URN first.');
    }

    if (ref.kind === 'air') {
        return { air: ref.air, name: 'the AIR you pasted', versionName: '' };
    }

    if (ref.kind === 'foreign') {
        throw new Error('That is not a CivitAI model link, model id or AIR URN.');
    }

    if (ref.kind === 'version') {
        return await resolveModelVersion(ref.versionId);
    }

    if (ref.kind === 'model') {
        const model = await siteApiGet(`/models/${ref.modelId}`);
        const version = pickModelVersion(model, ref.versionId);
        const resolved = await resolveModelVersion(version.id);
        return { ...resolved, name: model.name || resolved.name };
    }

    // A bare number is ambiguous — it can be both a model and a version id. Users
    // copy it from a `/models/<id>` address far more often, and model ids are the
    // safer guess: resolving 2416142 as a version id silently returns a LoRA of
    // an entirely different model.
    try {
        const model = await siteApiGet(`/models/${ref.id}`);
        const version = pickModelVersion(model);
        const resolved = await resolveModelVersion(version.id);
        return { ...resolved, name: model.name || resolved.name };
    } catch {
        return await resolveModelVersion(ref.id);
    }
}

/**
 * Warns when a resolved AIR clearly belongs to another ecosystem.
 * @param {string} air Resolved AIR URN
 * @param {import('./engines.js').EngineProfile} profile Currently selected profile
 * @returns {string} Warning text, or an empty string when the URN fits
 */
function describeAirMismatch(air, profile) {
    if (isAirCompatible(air, profile)) {
        return '';
    }

    const bucket = /^(?:urn:)?air:([^:]+):/.exec(String(air))?.[1] || 'another';
    return `This model is from the "${bucket}" ecosystem, but "${profile.label}" runs on "${profile.ecosystem}". Pick a matching model.`;
}

/**
 * Builds a display label for a ResourceInfo entry.
 * @param {object} resource ResourceInfo
 * @returns {string} Label
 */
function modelLabel(resource) {
    const version = resource.versionName ? ` — ${resource.versionName}` : '';
    const size = resource.size ? ` (${(resource.size / (1024 * 1024 * 1024)).toFixed(1)} GB)` : '';
    return `${resource.resourceName || resource.air}${version}${size}`;
}

/**
 * Renders the cached checkpoint list into the searchable list control.
 *
 * The cache is a single flat array in the settings and is populated per ecosystem,
 * so it is filtered by AIR bucket here. Without that filter a list fetched under
 * sdxl stayed visible *and selectable* under anima, which then produced
 * `ecosystem: anima` together with `diffuserModel: urn:air:sdxl:…`.
 *
 * Entries are also validated rather than trusted: `model_cache` comes from
 * persisted settings, and a single `null` entry used to throw out of
 * `loadSettings()` and then out of every later engine switch and search keystroke,
 * breaking the picker until the page was reloaded.
 * @param {string} [filter] Search text (matches model and version names)
 */
function renderModelList(filter) {
    const profile = getProfile(settings().engine);
    const raw = settings().model_cache;
    const cached = (Array.isArray(raw) ? raw : [])
        .filter(entry => entry && typeof entry === 'object' && typeof entry.air === 'string' && entry.air)
        .filter(entry => isAirCompatible(entry.air, profile));
    const list = $('#cs_model_list').empty();
    const query = String(filter || '').trim().toLowerCase();
    const urn = settings().checkpoint_urn || '';

    if (profile.checkpoint) {
        // Always-first option: use whatever base weights the engine ships with
        const builtin = $('<div>').addClass('cs_model_item').attr('data-air', '').text(profile.needsCheckpoint
            ? `No checkpoint (required for ${profile.label})`
            : 'Built-in model (recommended)');

        if (!urn) {
            builtin.addClass('cs_selected');
        } else if (profile.needsCheckpoint) {
            builtin.addClass('cs_locked');
        }
        list.append(builtin);
    }

    // A custom URN that is not present in the cache stays selectable
    if (urn && !cached.some(m => m.air === urn)) {
        const custom = $('<div>').addClass('cs_model_item cs_selected').attr('data-air', urn);
        custom.append($('<span>').text(`Custom: ${urn}`));
        custom.append($('<span>').addClass('cs_model_meta').text('from the URN field'));
        list.append(custom);
    }

    const matches = cached.filter(m => !query || `${m.resourceName || ''} ${m.versionName || ''}`.toLowerCase().includes(query));
    const enabledCount = matches.filter(m => m.canGenerate).length;

    for (const model of matches) {
        const item = $('<div>').addClass('cs_model_item').attr('data-air', model.air);
        item.append($('<span>').text(modelLabel(model)));
        item.append($('<span>').addClass('cs_model_meta').text(model.canGenerate ? 'can generate' : 'generation disabled'));
        if (!model.canGenerate) {
            item.addClass('cs_locked');
        }
        if (model.air === urn) {
            item.addClass('cs_selected');
        }
        list.append(item);
    }

    if (!matches.length) {
        const hint = query
            ? `Nothing matches "${query}"`
            : (profile.checkpoint ? 'Press the refresh button to load the checkpoint list' : 'This engine has no checkpoint picker');
        list.append($('<div>').addClass('cs_model_empty').text(hint));
    }

    $('#cs_model_count').text(cached.length
        ? `Showing ${matches.length} of ${cached.length} (${enabledCount} enabled for generation)`
        : '');
}

/**
 * Refreshes the model list from the API and caches it in the settings.
 */
async function refreshModelList() {
    const s = settings();

    if (!s.api_key) {
        toastr.error('CivitAI API key is not set.', 'CivitAI Scene');
        return;
    }

    if (isBusy) {
        toastr.info(busyKind === 'generate'
            ? 'A generation is already running — press Stop first.'
            : 'Another request is already in flight.', 'CivitAI Scene');
        return;
    }

    isBusy = true;
    busyKind = 'models';
    abortController = new AbortController();
    const signal = abortController.signal;
    const icon = $('#cs_models_refresh .fa-solid');
    const originalIcon = icon.attr('class');
    icon.attr('class', 'fa-solid fa-circle-notch fa-fw fa-spin');
    const profile = getProfile(s.engine);
    setStatus(`Loading ${profile.label} checkpoints from the fleet…`);

    try {
        setStatus(`Loading ${profile.label} checkpoints from the fleet…`);
        const models = await fetchLoadedModels(signal, (scanned, found) => {
            setStatus(`Loading ${profile.label} checkpoints from the fleet… scanned ${scanned}, matched ${found}`);
        });
        const trimmed = models
            .sort((a, b) => Number(b.canGenerate) - Number(a.canGenerate) || String(a.resourceName || '').localeCompare(String(b.resourceName || '')))
            .slice(0, MODEL_CACHE_LIMIT)
            // The cache is shared by every engine, so each entry remembers which
            // ecosystem fetched it and renderModelList() filters on that.
            .map(m => ({ air: m.air, resourceName: m.resourceName, versionName: m.versionName, size: m.size, canGenerate: !!m.canGenerate, ecosystem: profile.ecosystem ?? null }));

        settings().model_cache = trimmed;
        saveSettingsDebounced();
        renderModelList(String($('#cs_model_search').val() || ''));
        setStatus(`Found ${trimmed.length} ${profile.label} checkpoint(s) on the fleet.`, 'success');

        if (!trimmed.length) {
            toastr.warning(`No loaded ${profile.label} checkpoints were found on the generation fleet. Paste a CivitAI link above and press Resolve to use a specific model instead.`, 'CivitAI Scene');
        }
    } catch (err) {
        if (signal.aborted) {
            toastr.info('Checkpoint refresh stopped.', 'CivitAI Scene');
            setStatus('');
        } else {
            // Not the generation job: must not touch the job log or the displayed image.
            showError(String(err?.message || err));
        }
    } finally {
        isBusy = false;
        busyKind = null;
        abortController = null;
        icon.attr('class', originalIcon);
    }
}

/**
 * Selects a resolution in the dropdown, adding a custom option if it is not listed.
 *
 * Previously injected options were never removed, so every engine switch appended
 * another permanent `(WxH) (custom)` entry and the list grew without bound.
 * @param {string} resolution Resolution in "WxH" format
 * @param {string} [label] Label for the added option
 */
function selectResolution(resolution, label = 'from preset') {
    const select = $('#cs_resolution');
    // Drop the options injected by earlier calls; the statically declared ones in
    // settings.html carry no marker class and are kept.
    select.find('option[data-cs-custom]').remove();

    let exists = select.find('option').filter((_, option) => option.value === resolution).length;

    if (!exists) {
        select.append($('<option>').attr({ value: resolution, 'data-cs-custom': '1' }).text(`${resolution} (${label})`));
    }

    select.val(resolution);
}

// The two free-text prompt fields, where an empty string is a deliberate value
// rather than "absent from the preset".
const PROMPT_FIELDS = new Set(['prompt_prefix', 'negative_prompt']);

/**
 * Writes a preset into the settings and refreshes the UI.
 * @param {object} preset Preset values
 * @param {string} label Source label shown to the user
 */
function applyPreset(preset, label) {
    const s = settings();
    const profile = getProfile(s.engine);

    for (const key of PRESET_FIELDS) {
        if (preset[key] === undefined || preset[key] === null) {
            continue;
        }
        // An empty string is only meaningful for the two prompt fields: clearing the
        // negative prompt is a real decision, and skipping it re-sent the default
        // negative to an engine the user had deliberately left without one.
        // For the numeric fields "" means "not set", so it is still ignored.
        if (preset[key] === '' && !PROMPT_FIELDS.has(key)) {
            continue;
        }
        setEngineValue(key, preset[key]);
    }

    if (profile.size === 'wh') {
        const min = profile.minSize ?? 64;
        const max = profile.maxSize ?? 2048;
        const width = Math.round(Number(engineValue('width', profile.defaultWidth ?? 1024)) || profile.defaultWidth || 1024);
        const height = Math.round(Number(engineValue('height', profile.defaultHeight ?? 1024)) || profile.defaultHeight || 1024);
        setEngineValue('width', clamp(width, min, max));
        setEngineValue('height', clamp(height, min, max));
    }

    if (profile.size === 'ratio' && preset.aspect_ratio) {
        s.aspect_ratio = String(preset.aspect_ratio);
    }

    if (profile.size === 'imageSize' && preset.image_size) {
        s.image_size = String(preset.image_size);
    }

    if (profile.size === 'openaiSize' && preset.openai_size) {
        s.openai_size = String(preset.openai_size);
    }

    if (profile.stepsField && profile.minSteps !== undefined) {
        const fallback = profile.defaultSteps ?? profile.minSteps;
        const value = Number(engineValue('steps', fallback));
        setEngineValue('steps', clamp(Math.round(Number.isFinite(value) ? value : fallback), profile.minSteps, profile.maxSteps));
    }

    if (profile.guidance) {
        const fallback = profile.defaultGuidance ?? profile.minGuidance ?? 1;
        const value = Number(engineValue('cfg_scale', fallback));
        setEngineValue('cfg_scale', clamp(Number.isFinite(value) ? value : fallback, profile.minGuidance ?? 0, profile.maxGuidance ?? 30));
    }

    if (profile.count) {
        setEngineValue('quantity', clamp(Math.round(Number(engineValue('quantity', 1)) || 1), 1, profile.maxCount ?? 12));
    }

    applyProfileToUI();
    $('#cs_prompt_prefix').val(s.prompt_prefix);
    $('#cs_negative_prompt').val(s.negative_prompt);
    saveSettingsDebounced();

    const summary = describeProfileState(profile);
    setStatus(`Preset applied (${label}): ${summary}`, 'success');
    console.log(`[${extensionName}] Preset applied (${label}): ${summary}`);
}

/**
 * Builds a short human-readable summary of the current parameters for a profile.
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 * @returns {string} Summary
 */
function describeProfileState(profile) {
    const parts = [];

    switch (profile.size) {
        case 'ratio': parts.push(String(settings().aspect_ratio || '1:1')); break;
        case 'imageSize': parts.push(String(settings().image_size || 'square_hd')); break;
        case 'openaiSize': parts.push(String(settings().openai_size || '1024x1024')); break;
        case 'none': break;
        default: parts.push(`${engineValue('width', profile.defaultWidth ?? 1024)}x${engineValue('height', profile.defaultHeight ?? 1024)}`);
    }

    if (profile.stepsField && profile.minSteps !== undefined) {
        parts.push(`${engineValue('steps', profile.defaultSteps ?? profile.minSteps)} steps`);
    }

    if (profile.guidance) {
        parts.push(`${profile.guidance} ${engineValue('cfg_scale', profile.defaultGuidance ?? 1)}`);
    }

    return parts.join(', ');
}

/**
 * Builds the preset storage key for the current selection.
 * Hosted engines have no checkpoint URN, so the profile id and model variant are used instead.
 * @returns {string} Preset key
 */
function presetKey() {
    const s = settings();
    const profile = getProfile(s.engine);
    const parts = [profile.id];

    if (perEngineOnly('model_variant')) {
        parts.push(perEngineOnly('model_variant'));
    }

    if (profile.checkpoint) {
        parts.push(s.checkpoint_urn || 'builtin');
    }

    return parts.join('|');
}

/**
 * Loads the settings the user saved for the current engine/checkpoint.
 * Nothing is parsed from the model page: everything is filled in by hand.
 */
function loadPresetForSelectedModel() {
    const s = settings();
    const profile = getProfile(s.engine);
    const key = presetKey();
    const userPreset = (s.model_presets || {})[key];

    if (userPreset) {
        applyPreset(userPreset, 'your saved preset');
        return;
    }

    if (profile.id === 'anima' && !s.checkpoint_urn) {
        applyPreset({ ...ANIMA_DEFAULT_PRESET }, 'Anima recipe defaults');
        return;
    }

    if (profile.defaultSteps !== undefined || profile.defaultGuidance !== undefined) {
        applyPreset({
            width: profile.defaultWidth ?? 1024,
            height: profile.defaultHeight ?? 1024,
            steps: profile.defaultSteps,
            cfg_scale: profile.defaultGuidance,
        }, `${profile.label} defaults`);
        return;
    }

    setStatus('No saved preset for this selection. Fill the fields in and press "Save current as my preset".');
}

/**
 * Stores the current generation parameters as a personal preset for the current selection.
 */
function saveCurrentPreset() {
    const s = settings();
    const presets = s.model_presets || (s.model_presets = {});
    const key = presetKey();
    const profile = getProfile(s.engine);

    presets[key] = {
        width: engineValue('width', profile.defaultWidth ?? 1024),
        height: engineValue('height', profile.defaultHeight ?? 1024),
        steps: engineValue('steps', profile.defaultSteps ?? 20),
        cfg_scale: engineValue('cfg_scale', profile.defaultGuidance ?? 4),
        prompt_prefix: s.prompt_prefix,
        negative_prompt: s.negative_prompt,
        aspect_ratio: s.aspect_ratio,
        image_size: s.image_size,
        openai_size: s.openai_size,
        quantity: engineValue('quantity', 1),
        savedAt: Date.now(),
    };

    saveSettingsDebounced();
    setStatus(`Current settings saved as your preset for ${profile.label}.`, 'success');
}

async function onWandButtonClick() {
    await generatePicture('wand');
}

async function onGenerateButtonClick() {
    await generatePicture('panel');
}

/**
 * Auto-generate hook: fires after every character reply.
 * @param {number} messageId Message index
 * @param {string} [type] Message source type
 */
async function onMessageReceived(messageId, type) {
    if (!settings().auto_generate || type === 'extension') {
        return;
    }

    const message = getContext().chat[messageId];

    if (!message || message.is_user || message.is_system) {
        return;
    }

    // Skip messages that already contain media (e.g. our own generated images)
    if (Array.isArray(message.extra?.media) && message.extra.media.length > 0) {
        return;
    }

    await generatePicture('auto');
}

/**
 * Renames the old `urn:air:…` preset keys to the new `<profile>|<model>|<urn>` layout,
 * so presets saved before the multi-engine update keep working.
 *
 * Three properties matter and all three were missing before:
 *
 * - Idempotent / non-destructive: a key that has already been migrated (or whose new
 *   key was written by a newer release) is never overwritten. The old code assigned
 *   unconditionally, so a second load could replace a good preset with a stale one.
 * - Alias-aware: the AIR bucket is a coarser namespace than the `ecosystem` enum, so
 *   the lookup goes through the AIR_BUCKETS table (`airBucketsFor`) rather than
 *   matching `profile.ecosystem` directly. Matching on the enum filed the legal SDXL
 *   bucket `illustrious` under anima, because no profile declares that ecosystem.
 * - Never destroys: an unrecognised bucket is left exactly where it is instead of
 *   being re-homed to `anima`, where it could never match a presetKey() again.
 */
function migrateLegacyPresets() {
    const presets = settings().model_presets;
    if (!presets || typeof presets !== 'object') {
        return;
    }

    // Reverse index: AIR bucket -> the ecosystem that claims it.
    const bucketToEcosystem = new Map();
    for (const profile of ENGINE_PROFILES) {
        for (const bucket of airBucketsFor(profile)) {
            if (!bucketToEcosystem.has(bucket)) {
                bucketToEcosystem.set(bucket, profile.ecosystem);
            }
        }
    }

    let changed = false;

    for (const key of Object.keys(presets)) {
        if (!key.startsWith('urn:air:')) {
            continue;
        }

        const bucket = (/^urn:air:([^:]+):/i.exec(key)?.[1] || '').toLowerCase();
        const ecosystem = bucketToEcosystem.get(bucket);
        const profile = ecosystem
            ? ENGINE_PROFILES.find(p => p.checkpoint && p.ecosystem === ecosystem)
            : null;

        if (!profile) {
            // Unknown bucket: leave the preset untouched rather than destroying it.
            console.warn(`[${extensionName}] Legacy preset "${key}" belongs to an unknown AIR bucket "${bucket}" and was left unmigrated.`);
            continue;
        }

        const newKey = [profile.id, key].join('|');

        if (!Object.hasOwn(presets, newKey)) {
            presets[newKey] = presets[key];
        }

        delete presets[key];
        changed = true;
    }

    if (changed) {
        saveSettingsDebounced();
    }
}

/**
 * Fills the engine dropdown with every known profile, grouped by engine.
 */
function renderEngineSelect() {
    const select = $('#cs_engine').empty();
    const groups = new Map();

    for (const profile of ENGINE_PROFILES) {
        if (!groups.has(profile.engine)) {
            groups.set(profile.engine, []);
        }
        groups.get(profile.engine).push(profile);
    }

    for (const [engine, profiles] of groups) {
        const group = $('<optgroup>').attr('label', engine);
        for (const profile of profiles) {
            group.append($('<option>').attr('value', profile.id).text(profile.label));
        }
        select.append(group);
    }
}

/**
 * Shows or hides the parameter controls the selected profile actually accepts
 * and syncs their limits/defaults with the profile definition.
 *
 * The engine-specific enum selectors (model / version / parameter size / sampler /
 * scheduler) are read and written per engine and are deliberately NOT cleared when
 * the current profile has no such control: wiping them meant that switching to an
 * engine without a sampler and back silently reset the saved sampler to the first
 * enum member. The control is only hidden.
 */
function applyProfileToUI() {
    const s = settings();
    const profile = getProfile(s.engine);

    $('#cs_engine').val(profile.id);
    $('#cs_engine_note').text(profile.note || '');

    // Model variant
    const variantRow = $('#cs_model_variant').parent();
    if (profile.modelOptions?.length) {
        const options = profile.modelOptions;
        const stored = perEngineOnly('model_variant');
        const selected = options.includes(stored) ? stored : profile.model;
        $('#cs_model_variant').empty();
        for (const value of options) {
            $('#cs_model_variant').append($('<option>').attr('value', value).text(value));
        }
        $('#cs_model_variant').val(selected);
        setEngineValue('model_variant', selected);
        variantRow.removeClass('hidden');
    } else {
        $('#cs_model_variant').empty();
        variantRow.addClass('hidden');
    }

    // Model version
    if (profile.versionOptions?.length) {
        const options = profile.versionOptions;
        const stored = perEngineOnly('model_version');
        const selected = options.includes(stored) ? stored : profile.version;
        $('#cs_model_version').empty();
        for (const value of options) {
            $('#cs_model_version').append($('<option>').attr('value', value).text(value));
        }
        $('#cs_model_version').val(selected);
        setEngineValue('model_version', selected);
        $('#cs_model_version_row').removeClass('hidden');
    } else {
        $('#cs_model_version').empty();
        $('#cs_model_version_row').addClass('hidden');
    }

    // Size mode
    $('#cs_size_group, #cs_ratio_group, #cs_image_size_group, #cs_openai_size_group').addClass('hidden');

    if (profile.size === 'ratio') {
        const ratios = profile.ratios || ['1:1'];
        if (!ratios.includes(s.aspect_ratio)) {
            s.aspect_ratio = ratios[0];
        }
        const select = $('#cs_aspect_ratio').empty();
        for (const ratio of ratios) {
            select.append($('<option>').attr('value', ratio).text(ratio));
        }
        select.val(s.aspect_ratio);
        $('#cs_ratio_group').removeClass('hidden');
    } else if (profile.size === 'imageSize') {
        // The legal `imageSize` enum is per profile (Qwen 2 FAL has six members and no
        // portrait_9_16), so the shared WAN list cannot be rendered unconditionally.
        const sizes = imageSizesFor(profile);
        if (!sizes.includes(s.image_size)) {
            s.image_size = sizes[0];
        }
        const select = $('#cs_image_size').empty();
        for (const size of sizes) {
            select.append($('<option>').attr('value', size).text(size));
        }
        select.val(s.image_size);
        $('#cs_image_size_group').removeClass('hidden');
    } else if (profile.size === 'openaiSize') {
        const sizes = profile.openaiSizes || ['1024x1024'];
        if (!sizes.includes(s.openai_size)) {
            s.openai_size = sizes[0];
        }
        const select = $('#cs_openai_size').empty();
        for (const size of sizes) {
            select.append($('<option>').attr('value', size).text(size));
        }
        select.val(s.openai_size);
        $('#cs_openai_size_group').removeClass('hidden');
    } else if (profile.size === 'wh') {
        // Clamp here as well as in buildWorkflowInput(): the dropdown showed
        // 2048x2048 on a profile whose maximum is 1024 while the payload was silently
        // clamped, so the panel and the request disagreed about what would be sent.
        const min = profile.minSize ?? 64;
        const max = profile.maxSize ?? 2048;
        const width = clamp(Math.round(Number(engineValue('width', profile.defaultWidth ?? 1024)) || profile.defaultWidth || 1024), min, max);
        const height = clamp(Math.round(Number(engineValue('height', profile.defaultHeight ?? 1024)) || profile.defaultHeight || 1024), min, max);
        setEngineValue('width', width);
        setEngineValue('height', height);
        selectResolution(`${width}x${height}`, 'custom');
        $('#cs_resolution').attr('title', `Allowed range: ${min}–${max} px`);
        $('#cs_size_group').removeClass('hidden');
    }

    // Flux 2 Klein parameter size
    if (profile.modelVersionOptions?.length) {
        const options = profile.modelVersionOptions;
        const stored = perEngineOnly('model_version_variant');
        const selected = options.includes(stored) ? stored : options[0];
        setEngineValue('model_version_variant', selected);
        const select = $('#cs_model_version_variant').empty();
        for (const value of options) {
            select.append($('<option>').attr('value', value).text(value));
        }
        select.val(selected);
        $('#cs_model_version_variant_row').removeClass('hidden');
    } else {
        $('#cs_model_version_variant').empty();
        $('#cs_model_version_variant_row').addClass('hidden');
    }

    // Steps
    const stepsInput = $('#cs_steps');
    if (profile.stepsField && profile.minSteps !== undefined) {
        const fallback = profile.defaultSteps ?? profile.minSteps;
        // nullableControls schemas let the profile/model choose when the box is empty,
        // so an unset engine must show blank rather than the clamped minimum (which was
        // what made hidream-i1 emit cfgScale: 0 / steps: 1 and override the variant).
        const value = profile.nullableControls
            ? (perEngineOnly('steps') ?? '')
            : (Number(engineValue('steps', fallback)) || fallback);
        if (profile.nullableControls && perEngineOnly('steps') === undefined) {
            setEngineValue('steps', '');
        }
        stepsInput.attr('min', String(profile.minSteps));
        stepsInput.attr('max', String(profile.maxSteps));
        stepsInput.attr('placeholder', profile.nullableControls ? 'blank = model default' : '');
        stepsInput.val(value);
        $('#cs_steps_label').text(profile.stepsField === 'numInferenceSteps' ? 'Inference steps' : 'Steps');
        $('#cs_steps_group').removeClass('hidden');
    } else {
        $('#cs_steps_group').addClass('hidden');
    }

    // Guidance
    const cfgInput = $('#cs_cfg');
    const promptGuide = promptGuideFor(profile);

    if (profile.guidance) {
        const fallback = profile.defaultGuidance ?? profile.minGuidance ?? 1;
        const value = profile.nullableControls
            ? (perEngineOnly('cfg_scale') ?? '')
            : (Number(engineValue('cfg_scale', fallback)) || fallback);
        if (profile.nullableControls && perEngineOnly('cfg_scale') === undefined) {
            setEngineValue('cfg_scale', '');
        }
        cfgInput.attr('min', String(profile.minGuidance ?? 0));
        cfgInput.attr('max', String(profile.maxGuidance ?? 30));
        cfgInput.attr('step', String(profile.defaultGuidance && !Number.isInteger(profile.defaultGuidance) ? 0.5 : 1));
        cfgInput.attr('placeholder', profile.nullableControls ? 'blank = model default' : '');
        cfgInput.val(value);

        // cfgScale and guidanceScale are the same knob with different scales, so the
        // label says which field is being sent and the hint gives the useful range.
        // The label is a sibling of the input, not a parent, so it must be targeted by id.
        const isHosted = profile.guidance === 'guidanceScale';
        $('#cs_cfg_label').text(isHosted ? 'Guidance scale (guidanceScale)' : 'CFG scale (cfgScale)');
        cfgInput.attr('title', isHosted
            ? 'Distilled guidance (Flux-style). A different scale from CFG — 2.5-4 is typical, NOT 5-8.'
            : 'Classifier-free guidance. Higher = closer to the prompt, less variation.');
        $('#cs_cfg_hint').text(promptGuide.guidance);
        $('#cs_cfg_hint').removeClass('hidden');
        $('#cs_cfg_group').removeClass('hidden');
    } else {
        $('#cs_cfg_group').addClass('hidden');
    }

    // Prompt style: the two families need genuinely different prompt shapes.
    $('#cs_prompt_style_label').text(`Prompt style for this model: ${promptGuide.label}`);
    $('#cs_prompt_style_hint').text(promptGuide.hint);
    $('#cs_prompt_example').attr('data-example', promptGuide.example).toggleClass('hidden', !promptGuide.example);

    if (promptGuide.negative) {
        $('#cs_negative_hint').text(`Recommended negative for this model: ${promptGuide.negative}`);
        $('#cs_negative_hint_wrap').removeClass('hidden');
    } else {
        $('#cs_negative_hint').text(profile.negPrompt
            ? 'This schema has no negative prompt in the docs — it is usually ignored.'
            : 'This schema has no negative prompt field, so it is not sent at all.');
        $('#cs_negative_hint_wrap').removeClass('hidden');
    }

    $('#cs_negative_example').attr('data-example', promptGuide.negative || '').toggleClass('hidden', !promptGuide.negative);

    // Sampler / scheduler
    const samplerSelect = $('#cs_sampler');
    if (profile.samplers?.length) {
        const stored = perEngineOnly('sampler');
        const selected = profile.samplers.includes(stored) ? stored : (profile.defaultSampler ?? profile.samplers[0]);
        setEngineValue('sampler', selected);
        samplerSelect.empty();
        for (const value of profile.samplers) {
            samplerSelect.append($('<option>').attr('value', value).text(value));
        }
        samplerSelect.val(selected);
        $('#cs_sampler_group').removeClass('hidden');
    } else {
        $('#cs_sampler_group').addClass('hidden');
    }

    const schedulerSelect = $('#cs_scheduler');
    if (profile.schedulers?.length) {
        const stored = perEngineOnly('scheduler');
        const selected = profile.schedulers.includes(stored) ? stored : (profile.defaultScheduler ?? profile.schedulers[0]);
        setEngineValue('scheduler', selected);
        schedulerSelect.empty();
        for (const value of profile.schedulers) {
            schedulerSelect.append($('<option>').attr('value', value).text(value));
        }
        schedulerSelect.val(selected);
        $('#cs_scheduler_group').removeClass('hidden');
    } else {
        $('#cs_scheduler_group').addClass('hidden');
    }

    // Image count
    const quantityInput = $('#cs_quantity');
    if (profile.count) {
        quantityInput.attr('max', String(profile.maxCount ?? 12));
        quantityInput.val(Number(engineValue('quantity', 1)) || 1);
        $('#cs_quantity_group').removeClass('hidden');
    } else {
        $('#cs_quantity_group').addClass('hidden');
    }

    renderExtras(profile);
    renderExtraCheckpoints(profile);
    renderLoras(profile);

    // Checkpoint picker
    $('#cs_checkpoint_block').toggleClass('hidden', !profile.checkpoint);

    saveSettingsDebounced();
}

/**
 * Builds the simple extra controls (checkboxes and selects) declared by a profile.
 *
 * Every declared extra must end up with a real selected value that is written back
 * into `extra_flags`. Previously `select.val(extra.options?.includes(stored) ?
 * stored : extra.default)` was a no-op whenever `extra.default` was undefined:
 * `select.val(undefined)` is a *getter* in jQuery, the freshly built `<select>` was
 * still detached (so no option was auto-selected) and `null` got persisted, which
 * survived a reload and reached the payload.
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 */
function renderExtras(profile) {
    const block = $('#cs_extras_block').empty();
    const extras = profile.extras ?? [];
    const flags = settings().extra_flags || (settings().extra_flags = {});

    for (const extra of extras) {
        const id = `cs_extra_${extra.key}`;
        block.append($('<label>').attr('for', id).text(extra.label));

        if (extra.type === 'bool') {
            // The rendered state is written back so what the panel shows is what the
            // payload will carry (buildWorkflowInput now honours `extra.default`).
            const checked = (flags[extra.key] ?? extra.default) === true
                || (flags[extra.key] ?? extra.default) === 'true';
            flags[extra.key] = checked;
            block.append($('<input>').attr({ id: id, type: 'checkbox', class: 'text_pole' })
                .prop('checked', checked));
        } else if (extra.type === 'enum') {
            const options = extra.options ?? [];
            if (!options.length) {
                continue;
            }
            const select = $('<select>').attr({ id: id, class: 'text_pole' });
            for (const option of options) {
                select.append($('<option>').attr('value', option).text(option));
            }
            const stored = flags[extra.key];
            // Always ends up on a legal member: the stored value, else the declared
            // default, else the first option. Never undefined, never null.
            const selected = options.includes(stored)
                ? stored
                : (options.includes(extra.default) ? extra.default : options[0]);
            select.val(selected);
            flags[extra.key] = selected;
            block.append(select);
        } else if (extra.type === 'integer') {
            const stored = flags[extra.key];
            flags[extra.key] = Math.round(Number(stored ?? extra.default ?? 0)) || 0;
            block.append($('<input>').attr({
                id: id, class: 'text_pole', type: 'number',
                min: String(extra.min ?? -100), max: String(extra.max ?? 100), step: '1',
            }).val(flags[extra.key]));
        } else if (extra.type === 'number') {
            const stored = flags[extra.key];
            flags[extra.key] = Number(stored ?? extra.default ?? 0) || 0;
            block.append($('<input>').attr({
                id: id, class: 'text_pole', type: 'number',
                min: String(extra.min ?? -100), max: String(extra.max ?? 100), step: 'any',
            }).val(flags[extra.key]));
        }
    }
}

/**
 * Builds the extra mandatory base-weight inputs (the Flux 1 VAE / CLIP-L / T5 stack).
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 */
function renderExtraCheckpoints(profile) {
    const block = $('#cs_extra_checkpoints_block').empty();
    const extras = profile.extraCheckpoints ?? [];
    const store = settings().extra_checkpoints || (settings().extra_checkpoints = {});

    for (const extra of extras) {
        const id = `cs_extra_ck_${extra.field}`;
        block.append($('<label>').attr('for', id).text(`${extra.label} URN (AIR, required)`));
        block.append($('<div>').addClass('cs_model_row').append(
            $('<input>').attr({ id: id, class: 'text_pole', type: 'text' })
                .val(String(store[extra.field] || ''))
                .attr('placeholder', 'paste a CivitAI link or id, then Resolve'),
            $('<a>').addClass('menu_button cs_ck_resolve')
                .attr('data-field', extra.field)
                .attr('title', `Look up the ${extra.label} AIR on civitai.com`)
                .append($('<i>').addClass('fa-solid fa-magnifying-glass fa-fw')),
        ));
    }
}

/**
 * Renders the LoRA rows for the selected profile.
 *
 * The list is shared between engines (a LoRA you picked for SDXL stays in the
 * list when you look at another engine) but the block itself is hidden for the
 * closed API models, whose schemas have no `loras` field at all.
 * @param {import('./engines.js').EngineProfile} profile Engine profile
 */
function renderLoras(profile) {
    const block = $('#cs_loras_block');
    const supported = !!profile.loraForm;
    block.toggleClass('hidden', !supported);

    if (!supported) {
        // Drop the rows too: leaving them behind makes the list look editable
        // while the profile cannot send LoRAs at all.
        $('#cs_loras_list').empty();
        $('#cs_loras_status').text('');
        return;
    }

    const loras = settings().loras;
    if (!Array.isArray(loras)) {
        settings().loras = loras = [];
    }

    const list = $('#cs_loras_list').empty();

    loras.forEach((entry, index) => {
        const row = $('<div>').addClass('cs_lora_row');
        const airInput = $('<input>')
            .addClass('text_pole cs_lora_air')
            .attr('type', 'text')
            .attr('data-index', String(index))
            .val(entry.air || '')
            .attr('placeholder', 'CivitAI link, id or AIR URN');

        const strength = $('<input>')
            .addClass('text_pole cs_lora_strength')
            .attr({ type: 'number', step: '0.05', 'data-index': String(index) });

        if (profile.loraForm === 'array') {
            strength.attr({ min: '0', max: '4' });
        } else {
            // Map form has no documented cap, but negative weights are meaningful.
            strength.attr({ min: '-10', max: '10' });
        }
        strength.val(Number.isFinite(Number(entry.strength)) ? Number(entry.strength) : 1);

        const resolve = $('<a>').addClass('menu_button cs_lora_resolve')
            .attr('data-index', String(index))
            .attr('title', 'Look up the AIR on civitai.com')
            .append($('<i>').addClass('fa-solid fa-magnifying-glass fa-fw'));

        const remove = $('<a>').addClass('menu_button cs_lora_remove')
            .attr('data-index', String(index))
            .attr('title', 'Remove this LoRA')
            .append($('<i>').addClass('fa-solid fa-xmark fa-fw'));

        row.append(airInput, strength, resolve, remove);
        list.append(row);
    });

    const status = $('#cs_loras_status');

    if (!loras.length) {
        status.text('No LoRAs. Add one by pasting a CivitAI link, id or AIR URN.');
        return;
    }

    const problems = [];

    // Count the AIRs that will actually reach the payload, not the rows on screen.
    // Duplicate AIRs collapse into one map key, so "4 LoRA(s) will be sent" used to be
    // printed while two entries went out — and the status then cleared the mismatch
    // warning, because it never looked at what was really being sent.
    const sendable = loras.map(entry => String(entry.air || '').trim()).filter(Boolean);
    const unique = new Set(sendable);

    if (unique.size !== sendable.length) {
        problems.push(`${sendable.length - unique.size} duplicate AIR(s) collapse into one entry each — only the last row per AIR is sent.`);
    }

    const mismatched = [...unique].filter(air => !isAirCompatible(air, profile));
    if (mismatched.length) {
        problems.push(`${mismatched.length} LoRA(s) look like a different ecosystem than "${profile.ecosystem}" — they will still be sent, and "Estimate cost" will tell you if the API accepts them.`);
    }

    if (problems.length) {
        status.addClass('cs_resolve_warn').text(`${unique.size} LoRA(s) will be sent. ${problems.join(' ')}`);
    } else {
        status.removeClass('cs_resolve_warn').text(`${unique.size} LoRA(s) will be sent.`);
    }
}

/**
 * Writes a resolved AIR into a resource field and reports what was found.
 * @param {JQuery} statusEl Element that shows the result
 * @param {string} label Field name shown to the user
 * @param {string} rawText What the user pasted
 * @param {(air: string) => void} apply Stores the resolved AIR
 */
async function resolveIntoField(statusEl, label, rawText, apply) {
    statusEl.removeClass('cs_resolve_warn cs_resolve_ok').text('Looking up…');

    try {
        const { air, name, versionName } = await resolveCivitaiAir(rawText);
        apply(air);
        statusEl.addClass('cs_resolve_ok')
            .text(`${label}: ${name}${versionName ? ` — ${versionName}` : ''}`);

        const profile = getProfile(settings().engine);
        const mismatch = describeAirMismatch(air, profile);

        if (mismatch) {
            statusEl.removeClass('cs_resolve_ok').addClass('cs_resolve_warn').text(mismatch);
        }
    } catch (error) {
        statusEl.addClass('cs_resolve_warn').text(String(error?.message || error));
    }
}

async function loadSettings() {
    if (extension_settings.civitai_scene === undefined) {
        extension_settings.civitai_scene = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings.civitai_scene[key] === undefined) {
            extension_settings.civitai_scene[key] = value;
        }
    }

    // Migration: reasoning models need more tokens than the old 400 default
    if (extension_settings.civitai_scene.response_length <= 400) {
        extension_settings.civitai_scene.response_length = 1024;
    }

    // Migration: profiles added after the first multi-engine release
    if (ENGINE_PROFILES.every(p => p.id !== settings().engine)) {
        settings().engine = 'anima';
    }

    // Migration: presets used to be keyed by the raw checkpoint URN only
    migrateLegacyPresets();

    renderEngineSelect();
    $('#cs_api_key').val(settings().api_key);
    $('#cs_checkpoint_urn').val(settings().checkpoint_urn);
    $('#cs_scene_depth').val(settings().scene_depth);
    $('#cs_response_length').val(settings().response_length);
    $('#cs_llm_instruction').val(settings().llm_instruction);
    $('#cs_seed').val(settings().seed);
    $('#cs_prompt_prefix').val(settings().prompt_prefix);
    $('#cs_negative_prompt').val(settings().negative_prompt);
    $('#cs_allow_mature').prop('checked', settings().allow_mature);
    $('#cs_yellow_only').prop('checked', settings().yellow_only);
    $('#cs_auto_generate').prop('checked', settings().auto_generate);
    applyProfileToUI();
    renderModelList();
}

/**
 * Removes everything this module registered.
 *
 * `init()` can run more than once in a page session (extension reload / hot reload).
 * Without this, each run left another `MESSAGE_RECEIVED` listener and another set of
 * DOM handlers alive in its own module scope, so a single click started two
 * concurrent generations that fought over one settings object and two `isBusy` flags.
 *
 * @returns {void}
 */
function teardown() {
    if (abortController) {
        abortController.abort('Extension reinitialised');
        abortController = null;
    }
    isBusy = false;
    busyKind = null;

    eventSource.removeListener(event_types.MESSAGE_RECEIVED, onMessageReceived);

    // SlashCommandParser has no removal API, but the registry is a plain static map.
    delete SlashCommandParser.commands.csimage;
    delete SlashCommandParser.commands.civitai;

    // Handlers bound by delegated selectors live on an ancestor, so every element the
    // extension owns has to be swept, not just the leaves.
    $('#civitai_scene_gen, #civitai_scene_gen *').off();
    $('#cs_quick_gen').off().remove();
    // The template's root IS `.civitai_scene_settings` and the menu entry IS
    // `#civitai_scene_gen` — both are appended straight into SillyTavern's containers,
    // so they are removed by their own identity rather than by a wrapper that does not
    // exist (looking for one silently removed nothing and let the panels stack up).
    $('.civitai_scene_settings').find('*').addBack().off();
    $('#civitai_scene_gen').remove();
    $('.civitai_scene_settings').remove();
}

export async function init() {
    // A second init() must not leave the first one's handlers behind.
    teardown();

    const buttonHtml = await renderExtensionTemplateAsync(extensionName, 'button');
    $('#extensionsMenu').append(buttonHtml);

    const template = await renderExtensionTemplateAsync(extensionName, 'settings');
    $('#extensions_settings2').append(template);

    // Quick action button next to the message input (left of the send bar)
    const quickButton = $('<div>')
        .attr('id', 'cs_quick_gen')
        .addClass('fa-solid fa-wand-magic-sparkles interactable')
        .attr('title', 'Generate image from the scene (CivitAI)')
        .attr('tabindex', '0');
    $('#leftSendForm').append(quickButton);

    $('#civitai_scene_gen').on('click', onWandButtonClick);
    $('#cs_quick_gen').on('click', onWandButtonClick);
    $('#cs_generate').on('click', onGenerateButtonClick);
    $('#cs_estimate').on('click', estimateCost);

    // Prompt templates: the docs recommend different prompt shapes per family, so the
    // example is loaded from the profile guide rather than hard-coded in the markup.
    $('#cs_prompt_example').on('click', function () {
        const example = String($(this).attr('data-example') || '');
        if (example) {
            $('#cs_prompt_prefix').val(example).trigger('input');
        }
    });

    $('#cs_negative_example').on('click', function () {
        const example = String($(this).attr('data-example') || '');
        if (example) {
            $('#cs_negative_prompt').val(example).trigger('input');
        }
    });

    // Job log
    $('#cs_joblog_clear').on('click', function () {
        $('#cs_joblog').empty();
        jobLog.lines = [];
        setJobLogSummary('Log cleared.');
        setJobLogState('idle');
    });

    $('#cs_joblog_copy').on('click', async function () {
        const text = jobLog.lines.map(line => line.message).join('\n') || 'Log is empty.';
        try {
            await navigator.clipboard.writeText(text);
            toastr.success('Generation log copied to the clipboard.', 'CivitAI Scene');
        } catch {
            toastr.error('Clipboard access was denied by the browser.', 'CivitAI Scene');
        }
    });

    $('#cs_joblog_cancel').on('click', cancelWorkflowJob);
    $('#cs_models_refresh').on('click', refreshModelList);
    $('#cs_preset_load').on('click', loadPresetForSelectedModel);
    $('#cs_preset_save').on('click', saveCurrentPreset);

    $('#cs_model_search').on('input', function () {
        renderModelList(String($(this).val() || ''));
    });

    $('#cs_model_list').on('click', '.cs_model_item', function () {
        const item = $(this);

        if (item.hasClass('cs_locked')) {
            toastr.warning('This checkpoint is not enabled for cloud generation on CivitAI.', 'CivitAI Scene');
            return;
        }

        const urn = String(item.attr('data-air') || '');
        settings().checkpoint_urn = urn;
        $('#cs_checkpoint_urn').val(urn);
        saveSettingsDebounced();
        renderModelList(String($('#cs_model_search').val() || ''));
        const label = item.find('span').first().text() || 'Built-in Anima model';
        setStatus(`Model selected: ${label}`, 'success');
    });

    // Sync the list when the user pastes a custom URN manually
    $('#cs_checkpoint_urn').on('change', () => renderModelList(String($('#cs_model_search').val() || '')));

    $('#cs_api_key').on('input', function () {
        settings().api_key = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_checkpoint_urn').on('input', function () {
        settings().checkpoint_urn = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_scene_depth').on('input', function () {
        settings().scene_depth = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_response_length').on('input', function () {
        settings().response_length = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_llm_instruction').on('input', function () {
        settings().llm_instruction = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_engine').on('change', function () {
        settings().engine = String($(this).val());

        const profile = getProfile(settings().engine);

        // A freshly selected engine must start from its own recipe values. Done before
        // applyProfileToUI() reads them, and skipped entirely when the engine already
        // has a per-engine record, so nothing the user configured is overwritten.
        seedEngineRecipeDefaults(profile);

        // A checkpoint URN encodes its ecosystem, so an URN picked for another engine
        // would be rejected with a 400 — drop it when the ecosystem no longer matches.
        const urn = String(settings().checkpoint_urn || '');

        if (profile.checkpoint && urn && !isAirCompatible(urn, profile)) {
            settings().checkpoint_urn = '';
            $('#cs_checkpoint_urn').val('');
            $('#cs_checkpoint_status').removeClass('cs_resolve_ok').addClass('cs_resolve_warn')
                .text('Cleared the checkpoint — it belonged to another ecosystem.');
            toastr.info('Cleared the checkpoint — it belonged to another ecosystem.', 'CivitAI Scene');
        }

        saveSettingsDebounced();
        applyProfileToUI();
        renderModelList();
    });

    $('#cs_model_variant').on('change', function () {
        setEngineValue('model_variant', String($(this).val()));
        saveSettingsDebounced();
    });

    $('#cs_model_version').on('change', function () {
        setEngineValue('model_version', String($(this).val()));
        saveSettingsDebounced();
    });

    $('#cs_aspect_ratio').on('change', function () {
        settings().aspect_ratio = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_image_size').on('change', function () {
        settings().image_size = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_openai_size').on('change', function () {
        settings().openai_size = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_model_version_variant').on('change', function () {
        setEngineValue('model_version_variant', String($(this).val()));
        saveSettingsDebounced();
    });

    // Extra profile-specific controls are rebuilt on every engine switch, so the
    // handlers are delegated from the container.
    $('#cs_extras_block').on('change input', 'input, select', function () {
        const id = String($(this).attr('id') || '').replace('cs_extra_', '');
        const flags = settings().extra_flags || (settings().extra_flags = {});
        flags[id] = $(this).is(':checkbox') ? $(this).prop('checked') : ($(this).is('input') ? Number($(this).val()) : String($(this).val()));
        saveSettingsDebounced();
    });

    $('#cs_extra_checkpoints_block').on('input', 'input', function () {
        const field = String($(this).attr('id') || '').replace('cs_extra_ck_', '');
        const store = settings().extra_checkpoints || (settings().extra_checkpoints = {});
        store[field] = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#cs_extra_checkpoints_block').on('click', '.cs_ck_resolve', async function (event) {
        event.preventDefault();
        const field = String($(this).attr('data-field') || '');
        const store = settings().extra_checkpoints || (settings().extra_checkpoints = {});
        // Read the field itself rather than the stored copy: a paste followed by an
        // immediate click would otherwise resolve an empty string.
        const current = String($(`#cs_extra_ck_${field}`).val() || store[field] || '');
        const status = $(`<small>`).addClass('cs_resolve_status').insertAfter(`#cs_extra_ck_${field}`);

        await resolveIntoField(status, field, current, (air) => {
            store[field] = air;
            $(`#cs_extra_ck_${field}`).val(air);
            saveSettingsDebounced();
        });
    });

    // Resolve whatever sits in the checkpoint AIR field.
    $('#cs_checkpoint_resolve').on('click', async function (event) {
        event.preventDefault();
        const text = String($('#cs_checkpoint_urn').val() || '');

        await resolveIntoField($('#cs_checkpoint_status'), 'Checkpoint', text, (air) => {
            settings().checkpoint_urn = air;
            $('#cs_checkpoint_urn').val(air);
            renderModelList();
            saveSettingsDebounced();
        });
    });

    // LoRA rows are rebuilt on every engine switch, so the handlers are delegated.
    $('#cs_loras_list').on('input', 'input', function () {
        const index = Number($(this).attr('data-index'));
        const lora = settings().loras[index];
        if (!lora) {
            return;
        }
        if ($(this).hasClass('cs_lora_strength')) {
            lora.strength = Number($(this).val());
        } else {
            lora.air = String($(this).val()).trim();
        }
        saveSettingsDebounced();
    });

    $('#cs_lora_add').on('click', function (event) {
        event.preventDefault();
        settings().loras.push({ air: '', strength: 1 });
        renderLoras(getProfile(settings().engine));
        saveSettingsDebounced();
        $('#cs_loras_list .cs_lora_air').last().trigger('focus');
    });

    $('#cs_loras_list').on('click', '.cs_lora_remove', function (event) {
        event.preventDefault();
        settings().loras.splice(Number($(this).attr('data-index')), 1);
        renderLoras(getProfile(settings().engine));
        saveSettingsDebounced();
    });

    $('#cs_loras_list').on('click', '.cs_lora_resolve', async function (event) {
        event.preventDefault();
        const index = Number($(this).attr('data-index'));
        const lora = settings().loras[index];
        if (!lora) {
            return;
        }

        // Prefer whatever is literally in the box, so paste-then-click works.
        const current = String($(`#cs_loras_list .cs_lora_air[data-index="${index}"]`).val() || lora.air || '');
        const status = $('#cs_loras_status');
        await resolveIntoField(status, 'LoRA', current, (air) => {
            lora.air = air;
            renderLoras(getProfile(settings().engine));
            saveSettingsDebounced();
        });
    });

    $('#cs_sampler').on('change', function () {
        setEngineValue('sampler', String($(this).val()));
        saveSettingsDebounced();
    });

    $('#cs_scheduler').on('change', function () {
        setEngineValue('scheduler', String($(this).val()));
        saveSettingsDebounced();
    });

    $('#cs_quantity').on('input', function () {
        setEngineValue('quantity', Number($(this).val()));
        saveSettingsDebounced();
    });

    $('#cs_resolution').on('change', function () {
        const [width, height] = String($(this).val()).split('x').map(Number);
        if (width && height) {
            setEngineValue('width', width);
            setEngineValue('height', height);
            saveSettingsDebounced();
        }
    });

    $('#cs_steps').on('input', function () {
        // A cleared box on a nullableControls schema means "omit the field", so it must
        // stay an empty string — Number('') would have stored 0.
        const raw = String($(this).val() ?? '');
        setEngineValue('steps', raw === '' ? '' : Number(raw));
        saveSettingsDebounced();
    });

    $('#cs_cfg').on('input', function () {
        const raw = String($(this).val() ?? '');
        setEngineValue('cfg_scale', raw === '' ? '' : Number(raw));
        saveSettingsDebounced();
    });

    $('#cs_seed').on('input', function () {
        settings().seed = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_prompt_prefix').on('input', function () {
        settings().prompt_prefix = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_negative_prompt').on('input', function () {
        settings().negative_prompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cs_allow_mature').on('input', function () {
        settings().allow_mature = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cs_yellow_only').on('input', function () {
        settings().yellow_only = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cs_auto_generate').on('input', function () {
        settings().auto_generate = $(this).prop('checked');
        saveSettingsDebounced();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csimage',
        aliases: ['civitai'],
        returns: 'URL of the generated image, or an empty string if the generation failed',
        callback: async (args, value) => {
            const quiet = isTrueBoolean(args?.quiet?.toString());
            return await generatePicture('command', { trigger: String(value || '').trim(), quiet: quiet });
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'do not post the generated image into the chat',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumProvider: commonEnumProviders.boolean('trueFalse'),
                defaultValue: 'false',
                isRequired: false,
                acceptsMultiple: false,
            }),
        ],
        helpString: 'Generates an image with CivitAI (Anima). Without arguments the last scene is analyzed by the connected LLM to build the prompt. Provide a text to use it as a raw prompt instead.',
    }));

    await loadSettings();
    console.log(`[${extensionName}] Extension loaded`);
}

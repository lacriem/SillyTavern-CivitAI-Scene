/**
 * Runtime bridge to SillyTavern's own modules.
 *
 * Why this file exists
 * --------------------
 * SillyTavern serves an extension from one of two layouts, at two different depths:
 *
 *   1. system / local install - dropped into `public/scripts/extensions/<folder>/`
 *      -> served as `/scripts/extensions/<folder>/index.js`
 *   2. install from URL - cloned into `data/<user>/extensions/<folder>/`
 *      -> served as `/scripts/extensions/third-party/<folder>/index.js`
 *
 * The folder name is the repository name, so it is not something the extension can
 * hard-code. A plain relative import such as `../../extensions.js` therefore resolves
 * to the right file in layout 1 and to a 404 in layout 2 - and a module whose
 * dependency 404s fails to *link*, which the browser surfaces as an opaque
 * `error` event on the `<script>` tag. SillyTavern reports that as
 * `Extension "..." failed to load: [object Event]`, with no clue what went wrong.
 *
 * So instead of relative specifiers we compute SillyTavern's public root from
 * `import.meta.url` and import the modules by absolute URL. Both the base URL and
 * the extension key are derived from where this file was actually served from, so
 * the extension works no matter what it is called or where it is installed.
 *
 * A missing export is a plain `undefined` here rather than a link failure, so a
 * mismatch against the host version degrades to a readable error in the console
 * instead of an extension that never loads at all.
 */

const selfDirUrl = new URL('.', import.meta.url);

/**
 * SillyTavern's extension key for this extension, e.g. `civitai-scene` or
 * `third-party/SillyTavern-CivitAI-Scene`. This is the same string the client
 * uses, and it is what `renderExtensionTemplateAsync()` expects as its first
 * argument.
 * @type {string}
 */
export const extensionKey = (() => {
    const marker = '/scripts/extensions/';
    const path = selfDirUrl.pathname;
    const at = path.indexOf(marker);
    if (at === -1) {
        // Unrecognised layout - fall back to the folder name, which is correct
        // for a plain `public/scripts/extensions/<folder>/` install.
        console.warn('[civitai-scene] Could not locate /scripts/extensions/ in the module URL; falling back to the folder name.', import.meta.url);
        return path.split('/').filter(Boolean).pop() ?? '';
    }
    return path.slice(at + marker.length).replace(/\/$/, '');
})();

/**
 * Root of SillyTavern's `public/` directory as an absolute URL.
 * @type {URL}
 */
const publicRootUrl = new URL(
    selfDirUrl.pathname.includes('/third-party/') ? '../../../../' : '../../../',
    selfDirUrl,
);

/** @param {string} relativePath Path relative to `public/` @returns {string} */
const publicUrl = (relativePath) => new URL(relativePath, publicRootUrl).href;

const [
    script,
    extensions,
    mods,
    constants,
    utils,
    slashCommandParser,
    slashCommand,
    slashCommandArgument,
    slashCommandCommonEnums,
    reasoning,
] = await Promise.all([
    import(/* @vite-ignore */ publicUrl('script.js')),
    import(/* @vite-ignore */ publicUrl('scripts/extensions.js')),
    import(/* @vite-ignore */ publicUrl('scripts/RossAscends-mods.js')),
    import(/* @vite-ignore */ publicUrl('scripts/constants.js')),
    import(/* @vite-ignore */ publicUrl('scripts/utils.js')),
    import(/* @vite-ignore */ publicUrl('scripts/slash-commands/SlashCommandParser.js')),
    import(/* @vite-ignore */ publicUrl('scripts/slash-commands/SlashCommand.js')),
    import(/* @vite-ignore */ publicUrl('scripts/slash-commands/SlashCommandArgument.js')),
    import(/* @vite-ignore */ publicUrl('scripts/slash-commands/SlashCommandCommonEnumsProvider.js')),
    import(/* @vite-ignore */ publicUrl('scripts/reasoning.js')),
]);

export const {
    eventSource,
    event_types,
    generateRaw,
    saveSettingsDebounced,
    substituteParamsExtended,
    systemUserName,
} = script;

export const { extension_settings, getContext, renderExtensionTemplateAsync } = extensions;
export const { getMessageTimeStamp, humanizedDateTime } = mods;
export const { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } = constants;
export const { clamp, delay, getBase64Async, isTrueBoolean, saveBase64AsFile } = utils;
export const { SlashCommandParser } = slashCommandParser;
export const { SlashCommand } = slashCommand;
export const { ARGUMENT_TYPE, SlashCommandNamedArgument } = slashCommandArgument;
export const { commonEnumProviders } = slashCommandCommonEnums;
export const { removeReasoningFromString } = reasoning;

/**
 * Everything index.js needs from the host, in one place, so a version mismatch
 * produces a single actionable message instead of an `undefined` that only blows
 * up later inside some unrelated feature.
 * @type {Record<string, string>}
 */
const REQUIRED = {
    eventSource: script.eventSource,
    event_types: script.event_types,
    generateRaw: script.generateRaw,
    saveSettingsDebounced: script.saveSettingsDebounced,
    substituteParamsExtended: script.substituteParamsExtended,
    systemUserName: script.systemUserName,
    extension_settings: extensions.extension_settings,
    getContext: extensions.getContext,
    renderExtensionTemplateAsync: extensions.renderExtensionTemplateAsync,
    getMessageTimeStamp: mods.getMessageTimeStamp,
    humanizedDateTime: mods.humanizedDateTime,
    MEDIA_DISPLAY: constants.MEDIA_DISPLAY,
    MEDIA_SOURCE: constants.MEDIA_SOURCE,
    MEDIA_TYPE: constants.MEDIA_TYPE,
    clamp: utils.clamp,
    delay: utils.delay,
    getBase64Async: utils.getBase64Async,
    isTrueBoolean: utils.isTrueBoolean,
    saveBase64AsFile: utils.saveBase64AsFile,
    SlashCommandParser: slashCommandParser.SlashCommandParser,
    SlashCommand: slashCommand.SlashCommand,
    ARGUMENT_TYPE: slashCommandArgument.ARGUMENT_TYPE,
    SlashCommandNamedArgument: slashCommandArgument.SlashCommandNamedArgument,
    commonEnumProviders: slashCommandCommonEnums.commonEnumProviders,
    removeReasoningFromString: reasoning.removeReasoningFromString,
};

const missing = Object.keys(REQUIRED).filter((name) => REQUIRED[name] === undefined);
if (missing.length > 0) {
    console.error(
        `[civitai-scene] This SillyTavern build is missing ${missing.length} API(s) the extension needs: ${missing.join(', ')}. ` +
        'Update SillyTavern (1.14.0 or newer) - see https://github.com/lacriem/SillyTavern-CivitAI-Scene#requirements.',
    );
}

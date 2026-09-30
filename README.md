# CivitAI Scene Generator

SillyTavern extension that turns the current roleplay scene into an image via the
[CivitAI Orchestration API](https://developer.civitai.com/orchestration/recipes/imageGen/).

You press one button (or type a slash command): the extension asks your **currently connected
LLM** to read the last few chat messages and describe the scene as an image prompt, then sends
that prompt to the CivitAI generation fleet and posts the resulting image into the chat.

No API server, no ComfyUI install, no dependencies — SillyTavern clones the repository and
loads `index.js`.

---

## Installation

**Extensions → Install extension → Install from URL**, paste:

```
https://github.com/lacriem/SillyTavern-CivitAI-Scene
```

Or, in the Extensions panel, use **Update** on an already-installed copy to pull new commits.

Manual install (git):

```bash
cd SillyTavern/public/scripts/extensions
git clone https://github.com/lacriem/SillyTavern-CivitAI-Scene
```

Then restart SillyTavern and open **Extensions → CivitAI Scene Generator**.

### Requirements

* SillyTavern **1.12.0** or newer.
* A **CivitAI API key** (create one at <https://civitai.com/> → *Account* → *API Keys*). It is paid
  out of your Buzz balance, so generation is never free.
* Any chat-completion connection you already have configured in SillyTavern — that is the model
  that writes the image prompt. No extra setup.

---

## Usage

### The wand button

An image button is injected next to the chat input bar. Click it, or use the matching entry in
the Extensions menu, to generate an image from the current scene. While a job is running the
button becomes a stop button.

### Slash commands

| Command | What it does |
| --- | --- |
| `/csimage` | Analyzes the last messages with the connected LLM and generates an image. |
| `/csimage <text>` | Uses `<text>` as the raw prompt verbatim — no LLM call at all. |
| `/csimage quiet=true` | Generates, but does not post the image into the chat. Returns the image URL. |
| `/civitai` | Alias for `/csimage`. |

Both commands **return the URL** of the generated image, so they can be piped into stscript or
used inside macros.

### Auto-generate

`Auto-generate after each reply` in the settings panel generates a picture every time a character
replies. It spends Buzz on each generation, so it is off by default.

---

## Settings

Everything lives under **Extensions → CivitAI Scene Generator**.

* **Prompt building** — how many trailing chat messages are handed to the LLM (`Scene depth`),
  the response budget (`LLM response length`, raise it to 1000+ for reasoning models), and the
  full `LLM instruction` that tells the model how to turn prose into a prompt. Edit it to bias
  the result toward your own art style.
* **Engine / model** — pick one of the 70+ profiles (see below). The model and version pickers
  are filled automatically for engines that need them.
* **Checkpoint picker** — lists the checkpoints currently loaded on the CivitAI generation
  fleet. Entries that the cloud cannot actually run are greyed out. `Resolve` turns a pasted
  `civitai.com/models/12345` link, a bare id, `modelId@versionId` or a full AIR URN into the exact
  URN the API expects. Leave it empty to use the model's built-in checkpoint.
* **LoRAs** — add LoRAs by CivitAI link, id or AIR URN, with per-LoRA weight.
* **Presets** — `Save current as my preset` stores resolution, steps, CFG and both prompts
  separately for each engine/model pair (the seed is never touched); `Load my preset` restores
  them, or falls back to the official recipe defaults.
* **Sampling** — resolution (or aspect ratio / image size / OpenAI size, depending on the engine),
  steps, guidance, sampler, scheduler, image count, seed, extras, prompt prefix and negative
  prompt. The `Use example` / `Use recommended negative` buttons drop in the values recommended
  for the selected model.
* **Billing** — `Allow mature content` (NSFW, charged in yellow Buzz) and `Spend yellow Buzz only`,
  which keeps green/blue balances untouched.
* **Estimate cost** — asks the API what a generation would cost before you spend it.
* **Generation log** — the raw submit/poll/result exchange for the last jobs, with a
  *Cancel job* button that kills the run on the CivitAI side.

### Presets are yours

Nothing is copied from the CivitAI website. The extension only knows the *shape* of each recipe;
the actual values come from the API's own schema. Presets are stored in SillyTavern's
`extension_settings.civitai_scene` and follow the chat with it.

---

## Supported models

Profiles are grouped by engine; each one knows its own fields, limits, prompt style and
recommended negative prompt.

**CivitAI workers** — Anima, SDXL 1024, SD 1.5 512, Flux 1, Flux 2 Klein, Flux 2 Dev,
Qwen-Image 20B, Z-Image Base, Z-Image Turbo

**Comfy workers** — the same checkpoints above plus Pony V7, HiDream I1, HiDream O1,
Krea v2 / v2 Raw / v2 Turbo, Ideogram 4, Z-Image, Qwen-Image 2.1, Boogu Base / Turbo,
Chroma, ERNIE / ERNIE Turbo, Lens Normal / Turbo, MageFlow 4B / 4B Turbo, Ming Design

**CivitAI API** — Flux 1.1 Pro, Flux 1.1 Pro Ultra, Flux 2 Dev / Flex / Klein / Max / Pro

**Third-party via CivitAI** — OpenAI GPT-Image 1.5 / 2 / 2.5 Flare / 2.5 Sunburst,
Google Imagen 4, Nano Banana 2 / 2 Lite / Pro, Gemini 2.5 Flash Image, Grok Imagine v1 / v2,
Ideogram, Seedream, Qwen Image, Krea v2 (Krea API), MuseImage, MAI Image, Qwen 2, Reve, WAN 2.2 /
2.5 / 2.7

**Editing / specialised** — Flux 1 Kontext (image editing), Lens Normal / Turbo

---

## How it works

1. `init()` renders `button.html` and `settings.html` through
   `renderExtensionTemplateAsync()`, injects the wand button, and registers `/csimage`.
2. On generate, the last `Scene depth` messages are sent to your connected LLM with the
   `LLM instruction`; the reply is cleaned up (reasoning blocks stripped) and used as the prompt.
3. `engines.js` turns the settings into the recipe payload for the selected profile —
   resolution, sampler, scheduler, CFG, LoRAs, checkpoint AIR, extras — with the per-profile
   clamping the API schema requires.
4. The job is submitted to the Orchestration API, polled, and the finished image(s) are posted
   into the chat, with Buzz deducted from the balance the request specified.

Requests are made from the browser, so **your API key is stored in SillyTavern's settings, not
sent to any third-party server by this extension.** It talks to `civitai.com` and to your own
SillyTavern backend.

---

## Development

`validate-profiles.mjs` is an offline validator for the profiles in `engines.js`. It reads the
official OpenAPI document and checks that the payloads `buildWorkflowInput()` produces for every
profile are accepted by the matching schema — no unknown fields, all required fields present,
and every value within its declared type, enum, length, range and `multipleOf` bounds. It sweeps
every enum member and the min/max/default of every numeric knob, because a single-payload check
hides out-of-spec bounds and non-first enum values.

```bash
curl -o imagegen.yaml https://orchestration.civitai.com/v2/consumer/recipes/imageGen/openapi.yaml
node validate-profiles.mjs          # or: npm run validate
```

It is dependency-free (the YAML subset it needs is parsed inline) and is not loaded by the
extension at runtime.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | UI, settings persistence, prompt building, job submit/poll, slash command. |
| `engines.js` | The 70+ model profiles and the payload builder. |
| `settings.html` | Settings panel template. |
| `button.html` | Wand button template. |
| `style.css` | Panel and button styling. |
| `manifest.json` | SillyTavern extension manifest. |
| `validate-profiles.mjs` | Offline schema validator (dev only). |

## Troubleshooting

**`Manifest file not found`** — the URL must point at the repository root, not at a file or a
subdirectory.

**Prompt looks empty or generic** — raise `LLM response length`; reasoning models spend most of
their budget thinking. Check the generation log for the raw request.

**Checkpoint is greyed out** — it is not loaded on the CivitAI generation fleet, so it cannot
generate. Pick another one or leave the field empty for the built-in model.

**402 / insufficient Buzz** — the balance is empty. `Estimate cost` shows the price before you
commit; `Spend yellow Buzz only` prevents the charge from touching other balances.

**Job hangs** — open the generation log and use `Cancel job`.

## License

[MIT](LICENSE) © 2026 Lacriem

CivitAI, GPT-Image, Imagen, Flux, Qwen, Krea, WAN and the other named models belong to their
respective owners; this extension is an unofficial client and is not affiliated with any of them.

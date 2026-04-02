import {
    extension_settings,
    loadExtensionSettings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

const EXTENSION_NAME = 'nai-image-gen';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_SECRET_KEY = 'api_key_openrouter';

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_SYSPROMPT = `replaceme`;

const DEFAULT_CHEATSHEET = `replaceme`;

// ─── Settings ─────────────────────────────────────────────────────────────────

const defaultSettings = {
    model: 'google/gemini-2.0-flash-001',
    contextMessages: 5,
    sysprompt: DEFAULT_SYSPROMPT,
    cheatsheet: DEFAULT_CHEATSHEET,
};

extension_settings[EXTENSION_NAME] = extension_settings[EXTENSION_NAME] || {};
const settings = Object.assign({}, defaultSettings, extension_settings[EXTENSION_NAME]);
// Always ensure large text defaults are present if missing
if (!settings.sysprompt) settings.sysprompt = DEFAULT_SYSPROMPT;
if (!settings.cheatsheet) settings.cheatsheet = DEFAULT_CHEATSHEET;
extension_settings[EXTENSION_NAME] = settings;

function saveSettings() {
    saveSettingsDebounced();
}

// ─── Settings UI ──────────────────────────────────────────────────────────────

function bindSettingsUi() {
    $('#nai_image_gen_model').val(settings.model);
    $('#nai_image_gen_context_messages').val(settings.contextMessages);
    $('#nai_image_gen_sysprompt').val(settings.sysprompt);
    $('#nai_image_gen_cheatsheet').val(settings.cheatsheet);

    $('#nai_image_gen_model').on('input', function () {
        settings.model = $(this).val().trim();
        saveSettings();
    });

    $('#nai_image_gen_context_messages').on('input', function () {
        const v = parseInt($(this).val(), 10);
        if (!isNaN(v) && v > 0) {
            settings.contextMessages = v;
            saveSettings();
        }
    });

    $('#nai_image_gen_sysprompt').on('input', function () {
        settings.sysprompt = $(this).val();
        saveSettings();
    });

    $('#nai_image_gen_cheatsheet').on('input', function () {
        settings.cheatsheet = $(this).val();
        saveSettings();
    });

    $('#nai_image_gen_reset_sysprompt').on('click', function () {
        settings.sysprompt = DEFAULT_SYSPROMPT;
        $('#nai_image_gen_sysprompt').val(DEFAULT_SYSPROMPT);
        saveSettings();
    });

    $('#nai_image_gen_reset_cheatsheet').on('click', function () {
        settings.cheatsheet = DEFAULT_CHEATSHEET;
        $('#nai_image_gen_cheatsheet').val(DEFAULT_CHEATSHEET);
        saveSettings();
    });
}

async function renderSettings() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    $('#extensions_settings2').append(html);
    bindSettingsUi();
}

// ─── OpenRouter helpers ───────────────────────────────────────────────────────

function getRequestHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-CSRF-Token': SillyTavern.getContext().csrf_token || '',
    };
}

async function fetchSecretKey(key) {
    try {
        const response = await fetch('/api/secrets/find', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.value || null;
    } catch {
        return null;
    }
}

// ─── Core generation ──────────────────────────────────────────────────────────

async function runNaiPrep() {
    const ctx = SillyTavern.getContext();
    const userName = ctx.name1 || 'User';
    const charName = ctx.name2 || 'Character';

    // Get character description from the character card
    const character = ctx.characters?.[ctx.characterId];
    const charDescription = character?.description?.trim() || '(no description)';

    // Get recent N messages, skip hidden/system messages
    const chat = ctx.chat || [];
    const msgSlice = chat
        .filter(m => !m.is_system && m.mes)
        .slice(-settings.contextMessages);
    const recentMessages = msgSlice
        .map(m => `${m.name}: ${m.mes}`)
        .join('\n\n') || '(no messages)';

    // Fetch OpenRouter key from ST secret store
    const apiKey = await fetchSecretKey(OPENROUTER_SECRET_KEY);
    if (!apiKey) {
        throw new Error('[nai-image-gen] No OpenRouter API key found in ST settings. Add your key under API → OpenRouter.');
    }

    // Build system prompt — replace {user} placeholder with real name
    const sysprompt = settings.sysprompt.replaceAll('{user}', userName);

    // Build user message
    const userMessage = [
        `TAG REFERENCE:\n${settings.cheatsheet}`,
        `CHARACTER — ${charName}:\n${charDescription}`,
        `RECENT CHAT CONTEXT (last ${settings.contextMessages} messages):\n${recentMessages}`,
        `Determine how many distinct characters appear in the scene. If two or more, output multi-character format using | separators. Write the complete NAI V4.5 Full prompt string now.`,
    ].join('\n\n');

    const response = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': window.location.origin,
        },
        body: JSON.stringify({
            model: settings.model,
            messages: [
                { role: 'system', content: sysprompt },
                { role: 'user', content: userMessage },
            ],
            temperature: 0.3,
            max_tokens: 500,
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`[nai-image-gen] OpenRouter ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const prompt = data.choices?.[0]?.message?.content?.trim() || '';
    if (!prompt) {
        throw new Error('[nai-image-gen] OpenRouter returned an empty response.');
    }
    return prompt;
}

// ─── Slash command ────────────────────────────────────────────────────────────

async function importFromUrl(url) {
    return import(url);
}

async function registerSlashCommands() {
    const [
        { SlashCommandParser },
        { SlashCommand },
        { SlashCommandArgument, ARGUMENT_TYPE },
    ] = await Promise.all([
        importFromUrl('/scripts/slash-commands/SlashCommandParser.js'),
        importFromUrl('/scripts/slash-commands/SlashCommand.js'),
        importFromUrl('/scripts/slash-commands/SlashCommandArgument.js'),
    ]);

    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: 'nai-prep',
            helpString: 'Generate a NAI V4.5 image prompt from the current chat context via OpenRouter. Returns the prompt string into the pipe.',
            unnamedArgumentList: [],
            namedArgumentList: [],
            callback: async (_args, _text) => {
                try {
                    return await runNaiPrep();
                } catch (err) {
                    console.error(`[${EXTENSION_NAME}]`, err);
                    // Surface the error in ST's toast system
                    toastr.error(err.message, 'NAI Image Gen', { timeOut: 8000 });
                    return '';
                }
            },
        }),
    );
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

jQuery(async () => {
    await loadExtensionSettings(EXTENSION_NAME);
    await renderSettings();
    eventSource.on(event_types.APP_READY, registerSlashCommands);
});

/* Settings persistence: a single JSON file inside the app's userData folder. */
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DEFAULTS, SILENCE_CHOICES, ATTEMPT_CHOICES } = require('../shared/defaults');
const { LANGUAGES: SPOKEN_LANGUAGES, LEGACY_PROMPTS } = require('../shared/i18n');

const FILE = path.join(app.getPath('userData'), 'settings.json');
/* The app used to be called V2T: carry a configured install over rather than
 * asking for the key again. */
const LEGACY_FILE = path.join(path.dirname(app.getPath('userData')), 'V2T', 'settings.json');
const LANGUAGE_CODES = SPOKEN_LANGUAGES.map((l) => l.code);

let cache = null;

/* `fallback` supplies values for fields that are missing or unusable, so a bad
 * value from the UI can never wipe a working setting. */
function sanitize(raw, fallback) {
  const out = Object.assign({}, fallback || DEFAULTS);
  if (!raw || typeof raw !== 'object') return out;

  if (typeof raw.apiKey === 'string') out.apiKey = raw.apiKey.trim().slice(0, 300);
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim().slice(0, 120);
  if (typeof raw.language === 'string' && LANGUAGE_CODES.indexOf(raw.language) !== -1) out.language = raw.language;
  if (typeof raw.prompt === 'string') out.prompt = raw.prompt.slice(0, 4000);
  if (raw.uiLanguage === 'fa' || raw.uiLanguage === 'en') out.uiLanguage = raw.uiLanguage;
  if (typeof raw.shortcut === 'string' && /^[A-Za-z0-9+]+$/.test(raw.shortcut)) out.shortcut = raw.shortcut;
  if (SILENCE_CHOICES.indexOf(raw.silenceStopMs) !== -1) out.silenceStopMs = raw.silenceStopMs;
  if (ATTEMPT_CHOICES.indexOf(raw.attempts) !== -1) out.attempts = raw.attempts;
  if (typeof raw.copyToClipboard === 'boolean') out.copyToClipboard = raw.copyToClipboard;
  if (typeof raw.pasteAfterTranscribe === 'boolean') out.pasteAfterTranscribe = raw.pasteAfterTranscribe;
  if (typeof raw.launchAtLogin === 'boolean') out.launchAtLogin = raw.launchAtLogin;

  return out;
}

function migrateLegacy() {
  try {
    if (fs.existsSync(FILE) || !fs.existsSync(LEGACY_FILE)) return;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.copyFileSync(LEGACY_FILE, FILE);
    console.log('[store] migrated settings from the previous name');
  } catch (err) {
    console.error('[store] could not migrate settings:', err.message);
  }
}

function read() {
  if (cache) return cache;
  migrateLegacy();
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')), DEFAULTS);
  } catch (err) {
    cache = Object.assign({}, DEFAULTS);
  }
  /* The instruction text used to be bundled; the system prompt carries it now, so
   * an untouched copy of it would only be noise in the field. */
  const legacy = Object.keys(LEGACY_PROMPTS).map((k) => LEGACY_PROMPTS[k]);
  if (legacy.indexOf(cache.prompt) !== -1) cache.prompt = '';
  return cache;
}

function write(next) {
  cache = sanitize(next, cache || DEFAULTS);
  const tmp = FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[store] could not save settings:', err.message);
  }
  return cache;
}

/* Merges a partial update and persists it. */
function update(partial) {
  return write(Object.assign({}, read(), partial || {}));
}

module.exports = { read, update, path: FILE };

/* Settings persistence: a single JSON file inside the app's userData folder. */
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DEFAULTS, SILENCE_CHOICES, ATTEMPT_CHOICES } = require('../shared/defaults');
const { LANGUAGES: SPOKEN_LANGUAGES, LEGACY_PROMPTS } = require('../shared/i18n');
const { DEFAULT_PROMPT, PROMPT_REVISION } = require('../shared/prompt');

const FILE = path.join(app.getPath('userData'), 'settings.json');
/* The field is the instructions themselves, so the cap has to be above the app's
 * own text: at 4000 it silently cut the last rules off the default prompt, which
 * is a limit nobody would notice until the transcript was subtly wrong. It is here
 * to keep a runaway paste out of the settings file, not to size the instructions. */
const MAX_PROMPT_CHARS = 8000;
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
  if (typeof raw.prompt === 'string') out.prompt = raw.prompt.slice(0, MAX_PROMPT_CHARS);
  if (typeof raw.promptSeeded === 'string') out.promptSeeded = raw.promptSeeded.slice(0, MAX_PROMPT_CHARS);
  if (typeof raw.promptRevision === 'number') out.promptRevision = raw.promptRevision;
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

/* The prompt field changed meaning once. It used to be a place for the user's own
 * vocabulary, appended to the user turn, while the instructions lived in code; it
 * is now the instructions themselves. A file with no revision predates that, so it
 * gets the default text with whatever the user had written kept underneath — it was
 * never the app's to drop — and a file carrying the revision is left alone, because
 * the field is theirs from then on.
 *
 * `promptSeeded` records the text the app itself put there. It answers the one
 * question that cannot be answered by looking at the text: has the user edited
 * this? A field still holding what we wrote follows a better default; a field with
 * anything else in it is left exactly as it is, empty included. */
function seedPrompt() {
  const text = cache.prompt.trim();
  const ours = typeof cache.promptSeeded === 'string' && cache.promptSeeded === cache.prompt;

  /* Written as "is it current?" rather than "is it older?": a file with no
   * revision at all is the one that most needs this, and `undefined < 2` is false. */
  if (!(cache.promptRevision >= PROMPT_REVISION)) {
    const bundled = Object.keys(LEGACY_PROMPTS).map((k) => LEGACY_PROMPTS[k]);
    const mine = text && text !== DEFAULT_PROMPT && !ours && bundled.indexOf(text) === -1 ? text : '';
    cache.prompt = (mine ? `${DEFAULT_PROMPT}\n\n${mine}` : DEFAULT_PROMPT).slice(0, MAX_PROMPT_CHARS);
    cache.promptRevision = PROMPT_REVISION;
    cache.promptSeeded = DEFAULT_PROMPT;
    return;
  }

  /* The wording of the default improves over releases. A field nobody has touched
   * should get the better text: that is the whole reason the marker is kept. */
  if (cache.prompt === DEFAULT_PROMPT || ours) {
    cache.prompt = DEFAULT_PROMPT;
    cache.promptSeeded = DEFAULT_PROMPT;
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
  seedPrompt();
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

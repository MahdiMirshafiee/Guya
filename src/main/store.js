/* Settings persistence: a single JSON file inside the app's userData folder. */
'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { DEFAULTS, ATTEMPT_CHOICES } = require('../shared/defaults');
const { LANGUAGES: SPOKEN_LANGUAGES, LEGACY_PROMPTS } = require('../shared/i18n');
const { DEFAULT_PROMPT, PROMPT_REVISION } = require('../shared/prompt');

const FILE = path.join(app.getPath('userData'), 'settings.json');
/* The field is the instructions themselves, so the cap has to be above the app's
 * own text: at 4000 it silently cut the last rules off the default prompt, which
 * is a limit nobody would notice until the transcript was subtly wrong. It is here
 * to keep a runaway paste out of the settings file, not to size the instructions. */
const MAX_PROMPT_CHARS = 8000;
/* The app used to be called V2T, and a configured install is carried over rather than
 * asked for its key again. The file is copied whole, which is what makes the other
 * settings survive; the *encrypted* key in it only survives where the system's
 * encryption is not tied to the app that wrote it — DPAPI on Windows, which is per user.
 * On macOS the keychain entry belongs to the previous app name, so that launch shows "no
 * key yet" and the user types it once. The ciphertext is kept either way (see
 * `keptCiphertext`), so nothing is destroyed by the rename. */
const LEGACY_FILE = path.join(path.dirname(app.getPath('userData')), 'V2T', 'settings.json');
const LANGUAGE_CODES = SPOKEN_LANGUAGES.map((l) => l.code);

let cache = null;

/* A duration the user typed, in milliseconds: 0 is off, anything else is rounded to
 * a tenth of a second and kept inside what the form can express. A closed list of
 * choices is what the picker offers, not what the file may contain — someone who
 * wants 4.5 seconds should get 4.5 seconds. */
function sanitizeDuration(value, fallback) {
  if (value === 0) return 0; // 0 = off
  if (!Number.isFinite(value)) return fallback;
  return Math.min(120000, Math.max(1000, Math.round(value / 100) * 100));
}

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
  /* The accelerator the recorder produces can contain punctuation (`,` `.` `/` `;`
   * `'` `[` `]` `\` `-` `=` and the backtick); a pattern that rejected them made those
   * shortcuts work in the form and vanish in the file. */
  /* An empty string is a real answer — "no shortcut is held now" — which is what the file
   * holds when the key the user asked for was taken and the previous one could not be put
   * back. It is not a value to fall back from, so it is written as it comes. */
  if (typeof raw.shortcut === 'string' && (raw.shortcut === '' || /^[A-Za-z0-9+,\./;'[\]\\\-=`]+$/.test(raw.shortcut))) {
    out.shortcut = raw.shortcut;
  }
  if (raw.silenceStopMs !== undefined) out.silenceStopMs = sanitizeDuration(raw.silenceStopMs, out.silenceStopMs);
  if (raw.noSpeechStopMs !== undefined) out.noSpeechStopMs = sanitizeDuration(raw.noSpeechStopMs, out.noSpeechStopMs);
  if (ATTEMPT_CHOICES.indexOf(raw.attempts) !== -1) out.attempts = raw.attempts;
  if (typeof raw.copyToClipboard === 'boolean') out.copyToClipboard = raw.copyToClipboard;
  if (typeof raw.pasteAfterTranscribe === 'boolean') out.pasteAfterTranscribe = raw.pasteAfterTranscribe;
  if (typeof raw.launchAtLogin === 'boolean') out.launchAtLogin = raw.launchAtLogin;
  delete out.ok; // a report from the last save, never a setting

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

/* The API key is the user's, and a settings file is a plain text file: it is written
 * encrypted whenever the system offers an encryption service (the login keychain on
 * macOS, DPAPI on Windows), and read back from either form. A system that offers none
 * — some Linux sessions — keeps the plain field, because the alternative is an app
 * that cannot hold a key at all. */
function decryptKey(raw) {
  if (typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'));
    } catch (err) {
      console.warn('[store] could not read the saved key:', err.message);
    }
  }
  return null;
}

/* A key that could not be read this launch is not a key that should be deleted: the
 * ciphertext stays in the file, untouched, for the launch that can read it. Writing the
 * settings file without it — which is what happened on the next save, whatever that save
 * was about — is the app destroying the user's key because the keychain was not
 * reachable at the moment it looked. */
let keptCiphertext = null;

function read() {
  if (cache) return cache;
  migrateLegacy();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    /* A corrupt file is kept rather than overwritten: it holds a key the user would
     * otherwise have to find again. */
    if (err && err.code !== 'ENOENT') {
      try {
        fs.renameSync(FILE, FILE + '.bad');
        console.error('[store] settings could not be read; the old file is at', FILE + '.bad');
      } catch (_) {
        /* nothing more to do */
      }
    }
  }
  cache = sanitize(raw, DEFAULTS);
  if (raw) {
    const decrypted = decryptKey(raw);
    if (decrypted !== null) {
      cache.apiKey = decrypted;
      keptCiphertext = null;
    } else if (typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc) {
      keptCiphertext = raw.apiKeyEnc;
    }
  }
  seedPrompt();
  return cache;
}

/* The field is only written in the clear when there is no encryption to be had. */
function serializable(settings) {
  const out = Object.assign({}, settings);
  if (out.apiKey && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      out.apiKeyEnc = safeStorage.encryptString(out.apiKey).toString('base64');
      out.apiKey = '';
      return out;
    } catch (err) {
      console.warn('[store] could not encrypt the key:', err.message);
    }
  }
  /* Nothing to write in the clear, and a key on disk that this launch could not read:
   * it is kept as it was. */
  if (!out.apiKey && keptCiphertext) out.apiKeyEnc = keptCiphertext;
  return out;
}

function write(next) {
  cache = sanitize(next, cache || DEFAULTS);
  const tmp = FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(serializable(cache), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return { ok: true, settings: cache };
  } catch (err) {
    console.error('[store] could not save settings:', err.message);
    return { ok: false, settings: cache, errorKey: 'error.unexpected' };
  }
}

/* Merges a partial update and persists it. Returns the settings, so an existing
 * caller keeps working; `update.ok` says whether it reached the disk. */
function update(partial) {
  const patch = partial || {};
  /* A save that says nothing about the key is not a decision about the key: an unreadable
   * one is left on disk for the launch that can read it. A save that carries the field —
   * including one that empties it — is the user's decision, and it is obeyed. */
  if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) keptCiphertext = null;
  const result = write(Object.assign({}, read(), patch));
  /* A copy: the caller learns whether the save reached the disk, and the cached
   * settings — which are what gets written — never carry the report. */
  return Object.assign({}, result.settings, { ok: result.ok });
}

module.exports = { read, update, path: FILE };

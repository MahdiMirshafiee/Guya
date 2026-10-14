/* Defaults shared by the settings store and the UI. */
'use strict';

/* Keyboard shortcut: one press starts recording, the same one stops it. */
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';

/* Only used to pre-fill the model box; the real list comes from the API. */
const KNOWN_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

const MAX_RECORDING_MS = 300000;

/* Stop a recording on its own after this much silence. The value is a setting,
 * because waiting for it is the longest part of the round trip. */
const SILENCE_STOP_MS = 10000;
const SILENCE_CHOICES = [0, 3000, 5000, 10000, 20000];

/* Attempts per transcription, including the first. */
const ATTEMPT_CHOICES = [1, 2, 3, 5];

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-2.5-flash',
  language: 'auto',
  prompt: '',
  uiLanguage: 'fa',
  shortcut: DEFAULT_SHORTCUT,
  silenceStopMs: SILENCE_STOP_MS,
  attempts: 3,
  copyToClipboard: true,
  pasteAfterTranscribe: false,
  launchAtLogin: false
};

module.exports = { DEFAULTS, KNOWN_MODELS, MAX_RECORDING_MS, SILENCE_STOP_MS, SILENCE_CHOICES, ATTEMPT_CHOICES };

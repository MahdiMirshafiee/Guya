/* Defaults shared by the settings store and the UI. */
'use strict';

const { DEFAULT_PROMPT } = require('./prompt');

/* Keyboard shortcut: one press starts recording, the same one stops it. */
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';

/* What the picker offers before anything is asked of the API: the models this app is
 * built and tested against, newest first. "Refresh models" replaces the list with what the
 * user's own key can reach, and anything they type stays theirs. */
const KNOWN_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

const MAX_RECORDING_MS = 300000;

/* Two different waits, because "nobody has spoken yet" and "they have finished
 * speaking" are not the same question. The first runs while the user is deciding;
 * the second is the one they feel after every sentence. Both are settings, and both
 * accept any value in seconds through the form — the lists are only what is offered.
 * The end-of-speech default was ten seconds: every recording that stopped itself
 * cost the user ten seconds of waiting and uploaded ten seconds of silence. */
const SILENCE_STOP_MS = 3000;
const SILENCE_CHOICES = [0, 1500, 2000, 3000, 5000, 10000];
const NO_SPEECH_STOP_MS = 8000;
const NO_SPEECH_CHOICES = [0, 5000, 8000, 10000, 15000, 30000];

/* Attempts per transcription, including the first. */
const ATTEMPT_CHOICES = [1, 2, 3, 5];

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-3.1-flash-lite',
  language: 'auto',
  /* The field is seeded with the app's instructions by the store, which is the only
   * place that knows whether a file predates the field holding them. No
   * promptRevision here on purpose: a revision the store cannot read as old would
   * mean an install that keeps its vocabulary text and loses the rules. */
  prompt: DEFAULT_PROMPT,
  promptSeeded: DEFAULT_PROMPT,
  uiLanguage: 'fa',
  shortcut: DEFAULT_SHORTCUT,
  silenceStopMs: SILENCE_STOP_MS,
  noSpeechStopMs: NO_SPEECH_STOP_MS,
  attempts: 3,
  copyToClipboard: true,
  pasteAfterTranscribe: false,
  launchAtLogin: false
};

module.exports = {
  DEFAULTS,
  KNOWN_MODELS,
  MAX_RECORDING_MS,
  SILENCE_STOP_MS,
  SILENCE_CHOICES,
  NO_SPEECH_STOP_MS,
  NO_SPEECH_CHOICES,
  ATTEMPT_CHOICES
};

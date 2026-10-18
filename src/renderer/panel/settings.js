/*
 * Guya — the settings form.
 *
 * Every control writes through as it changes; there is no Save button and no
 * confirmation toast. The form's status line is reserved for state that is true
 * right now: a rejected shortcut, a key the provider refused, no key at all.
 */
'use strict';

const F = {
  apiKey: document.getElementById('apiKey'),
  toggleKey: document.getElementById('toggleKey'),
  toggleKeyIcon: document.getElementById('toggleKeyIcon'),
  modelSelect: document.getElementById('modelSelect'),
  modelCustom: document.getElementById('modelCustom'),
  refreshModels: document.getElementById('refreshModels'),
  language: document.getElementById('language'),
  prompt: document.getElementById('prompt'),
  resetPrompt: document.getElementById('resetPrompt'),
  shortcut: document.getElementById('shortcut'),
  shortcutRow: document.getElementById('shortcutRow'),
  openKeyPage: document.getElementById('openKeyPage'),
  shortcutHint: document.getElementById('shortcutHint'),
  silenceStop: document.getElementById('silenceStop'),
  silenceCustom: document.getElementById('silenceCustom'),
  silenceUnit: document.getElementById('silenceUnit'),
  noSpeechStop: document.getElementById('noSpeechStop'),
  noSpeechCustom: document.getElementById('noSpeechCustom'),
  noSpeechUnit: document.getElementById('noSpeechUnit'),
  attempts: document.getElementById('attempts'),
  copyToClipboard: document.getElementById('copyToClipboard'),
  pasteAfterTranscribe: document.getElementById('pasteAfterTranscribe'),
  launchAtLogin: document.getElementById('launchAtLogin'),
  uiLanguageSelect: document.getElementById('uiLanguageSelect'),
  quitFootnote: document.getElementById('quitFootnote'),
  quitApp: document.getElementById('quitApp'),
  pasteFootnote: document.getElementById('pasteFootnote'),
  pasteNotice: document.getElementById('pasteNotice'),
  pasteNeedsText: document.getElementById('pasteNeedsText'),
  pasteGrantedText: document.getElementById('pasteGrantedText'),
  openAccessibility: document.getElementById('openAccessibility'),
  askAccessibility: document.getElementById('askAccessibility'),
  status: document.getElementById('settingsStatus')
};

const CUSTOM_MODEL = '__custom__';

let models = [];
let shortcutDraft = '';
let capturingShortcut = false;
let formStatus = { key: null, vars: null, kind: '' };

/* --------------------------------------------------------------- status --- */

function setFormStatus(key, kind, vars) {
  formStatus = { key: key, vars: vars || null, kind: kind || '' };
  renderSettingsStatus();
}

/* The same rule as the recorder: silence unless something is true right now. */
function renderSettingsStatus() {
  if (!formStatus.key && !formStatus.text && appState.shortcutErrorKey) {
    formStatus = { key: appState.shortcutErrorKey, vars: null, kind: 'warn' };
  }
  const text = formStatus.key ? t(formStatus.key, formStatus.vars) : '';
  F.status.textContent = text || '';
  F.status.className = 'status' + (formStatus.kind ? ' ' + formStatus.kind : '');
}

/* ------------------------------------------------------- labelled fields --- */

function currentModel() {
  if (F.modelSelect.value === CUSTOM_MODEL) return F.modelCustom.value.trim();
  return F.modelSelect.value || settings.model;
}

/* The interface language re-draws every screen, so the values still sitting in the
 * fields travel with it — they are about to be re-read from the settings anyway. This
 * is the only caller: every other control sends what it changed and nothing else. */
function currentFormPatch() {
  return {
    apiKey: F.apiKey.value.trim(),
    model: currentModel(),
    language: F.language.value,
    prompt: F.prompt.value,
    uiLanguage: F.uiLanguageSelect.value || settings.uiLanguage,
    silenceStopMs: durationValue(F.silenceStop, F.silenceCustom, settings.silenceStopMs),
    noSpeechStopMs: durationValue(F.noSpeechStop, F.noSpeechCustom, settings.noSpeechStopMs),
    attempts: Number(F.attempts.value),
    shortcut: shortcutDraft || settings.shortcut,
    copyToClipboard: F.copyToClipboard.checked,
    pasteAfterTranscribe: F.pasteAfterTranscribe.checked,
    launchAtLogin: F.launchAtLogin.checked
  };
}

/* A duration is offered as a short list of sensible values plus "Custom…", which
 * reveals a number in seconds. The list is what is offered, not what is allowed: the
 * store accepts anything in range, so 4.5 seconds survives a restart. */
function secondsOf(ms) {
  return Math.round((ms / 1000) * 10) / 10;
}

/* The value a duration row is asking for. An empty or unusable Custom field is not a
 * request to turn the wait off: opening "Custom…" and clicking away used to write 0, which
 * the store reads as Off — the recording then stopped on nothing but the five-minute cap —
 * so an empty field keeps whatever is in force. */
function durationValue(select, input, inForceMs) {
  if (select.value !== CUSTOM_MODEL) return Number(select.value);
  const seconds = Number(input.value);
  if (!Number.isFinite(seconds) || seconds <= 0) return typeof inForceMs === 'number' ? inForceMs : 0;
  return Math.round(seconds * 1000);
}

function renderDuration(select, input, unit, currentMs, choices, language) {
  const number = new Intl.NumberFormat(language);
  const list = choices && choices.length ? choices : [0];
  const current = String(currentMs);
  const known = list.some((ms) => String(ms) === current);
  select.innerHTML = '';
  list.forEach((ms) => {
    const option = document.createElement('option');
    option.value = String(ms);
    option.textContent = ms === 0 ? t('ui.silenceOff') : t('ui.secondsShort', { count: number.format(secondsOf(ms)) });
    select.appendChild(option);
  });
  const custom = document.createElement('option');
  custom.value = CUSTOM_MODEL;
  custom.textContent = t('ui.customDuration');
  select.appendChild(custom);
  select.value = known ? current : CUSTOM_MODEL;
  const isCustom = select.value === CUSTOM_MODEL;
  input.hidden = !isCustom;
  unit.hidden = !isCustom;
  if (isCustom) input.value = String(secondsOf(currentMs));
}

/* A curated list plus a final "Custom…" entry: provider model names change
 * faster than releases, so a closed list would rot, and a bare text field would
 * make the common case worse. */
function renderModels() {
  /* The curated list arrives with the app info, and this form paints before the main
   * process has answered: seeded once at load time it seeded nothing, and the picker
   * offered the current model and "Custom…" — the two suggestions the footnote mentions
   * were reachable only by typing them. */
  if (!models.length && appState.knownModels) models = appState.knownModels.map((id) => ({ id }));
  const current = settings.model || '';
  F.modelSelect.innerHTML = '';

  const seen = new Set();
  const add = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    F.modelSelect.appendChild(option);
  };

  add(current);
  models.forEach((model) => add(model.id));

  const custom = document.createElement('option');
  custom.value = CUSTOM_MODEL;
  custom.textContent = t('ui.customModel');
  F.modelSelect.appendChild(custom);

  const isCustom = !!current && !seen.has(current);
  F.modelSelect.value = isCustom ? CUSTOM_MODEL : current || CUSTOM_MODEL;
  F.modelCustom.hidden = !isCustom;
  if (isCustom) F.modelCustom.value = current;
}

function renderLanguages() {
  const language = settings.uiLanguage === 'en' ? 'en' : 'fa';
  const spoken = F.language.value || settings.language;

  F.language.innerHTML = '';
  GuyaI18n.LANGUAGES.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.code;
    option.textContent = item[language];
    F.language.appendChild(option);
  });
  F.language.value = spoken;

  F.uiLanguageSelect.innerHTML = '';
  [
    { value: 'fa', key: 'ui.interfaceFa' },
    { value: 'en', key: 'ui.interfaceEn' }
  ].forEach((item) => {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = t(item.key);
    F.uiLanguageSelect.appendChild(option);
  });
  F.uiLanguageSelect.value = language;

  renderDuration(F.silenceStop, F.silenceCustom, F.silenceUnit, settings.silenceStopMs, appState.silenceChoices, language);
  renderDuration(F.noSpeechStop, F.noSpeechCustom, F.noSpeechUnit, settings.noSpeechStopMs, appState.noSpeechChoices, language);

  const attemptChoices = appState.attemptChoices || [3];
  F.attempts.innerHTML = '';
  attemptChoices.forEach((count) => {
    const option = document.createElement('option');
    option.value = String(count);
    option.textContent = t('ui.attemptsValue', { count: new Intl.NumberFormat(language).format(count) });
    F.attempts.appendChild(option);
  });
  F.attempts.value = String(settings.attempts || 3);
}

function renderShortcut() {
  F.shortcut.textContent = '';
  if (capturingShortcut) {
    [t('ui.pressKeys'), t('ui.escToCancel')].forEach((text) => {
      const hint = document.createElement('kbd');
      hint.className = 'key hint-key';
      hint.textContent = text;
      F.shortcut.appendChild(hint);
    });
    return;
  }
  const parts = GuyaAccelerator.displayParts(shortcutDraft || settings.shortcut);
  if (!parts.length) {
    /* No shortcut is held — the app says nothing rather than showing a combination it is
     * not listening for — and an empty field would read as a broken control. */
    const hint = document.createElement('kbd');
    hint.className = 'key hint-key';
    hint.textContent = t('ui.pressKeys');
    F.shortcut.appendChild(hint);
    return;
  }
  parts.forEach((part) => {
    const key = document.createElement('kbd');
    key.className = 'key';
    key.textContent = part;
    F.shortcut.appendChild(key);
  });
}

/* Called by the shell (which loads first) through window.__repaintSettings. */
function repaintSettings() {
  /* A field the user is typing in is theirs: a state push must not overwrite it
   * while a save is in flight. */
  const focused = document.activeElement;
  if (focused !== F.apiKey) F.apiKey.value = settings.apiKey || '';
  if (focused !== F.prompt) F.prompt.value = settings.prompt || '';
  F.copyToClipboard.checked = !!settings.copyToClipboard;
  F.pasteAfterTranscribe.checked = !!settings.pasteAfterTranscribe;
  F.launchAtLogin.checked = !!settings.launchAtLogin;
  F.toggleKey.setAttribute('aria-label', F.apiKey.type === 'password' ? t('ui.showKey') : t('ui.hideKey'));

  applyPasteSupport(pasteSupport);
  F.refreshModels.setAttribute('aria-label', t('ui.refreshModels'));
  F.resetPrompt.setAttribute('aria-label', t('ui.resetPrompt'));
  renderLanguages();
  renderModels();
  renderShortcut();
  renderShortcutNotice();
  renderSettingsStatus();
}

/* --------------------------------------------- the accessibility permission --- */

/* macOS owns this permission. Rather than only writing a sentence about it, the
 * app asks the system to say it in its own words, keeps checking, and only then
 * lets the setting stay on. */
let pasteWatch = null;
let pasteSupport = { supported: true, tool: null };

/* Whether this machine can type into another app at all, and with what. */
function applyPasteSupport(next) {
  pasteSupport = next || { supported: true, tool: null };
  F.pasteAfterTranscribe.disabled = !pasteSupport.supported;
  F.pasteFootnote.textContent = pasteSupport.supported ? t('settings.pasteFootnote') : t('settings.pasteNeedsTool');
  F.pasteFootnote.className = 'footnote' + (pasteSupport.supported ? '' : ' footnote-quiet');
}

function showPasteNotice(granted) {
  F.pasteNotice.hidden = false;
  F.pasteNotice.classList.toggle('is-granted', !!granted);
  F.openAccessibility.hidden = !!granted;
  F.askAccessibility.hidden = !!granted;
  /* One notice, two states, two sentences: the granted one used to say the permission was
   * required and that the option stays off, in green, right after it was granted. */
  F.pasteNeedsText.hidden = !!granted;
  F.pasteGrantedText.hidden = !granted;
  // The user just flipped a switch near the bottom of the form; bring the answer
  // to where they are looking instead of leaving it below the fold.
  F.pasteNotice.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function hidePasteNotice() {
  F.pasteNotice.hidden = true;
  stopPasteWatch();
}

function stopPasteWatch() {
  if (pasteWatch) clearInterval(pasteWatch);
  pasteWatch = null;
}

function watchForPastePermission() {
  stopPasteWatch();
  pasteWatch = setInterval(async () => {
    let status = { granted: false };
    try {
      status = await api.accessibilityStatus();
    } catch (_) {
      return;
    }
    if (!status.granted) return;
    stopPasteWatch();
    showPasteNotice(true);
    F.pasteAfterTranscribe.checked = true;
    await saveAndRepaint({ pasteAfterTranscribe: true });
  }, 1500);
}

async function askForPastePermission() {
  let result = { granted: false };
  try {
    result = await api.requestAccessibility();
  } catch (_) {
    /* fall through to the notice, which offers the settings pane by hand */
  }
  if (result.granted) {
    showPasteNotice(true);
    F.pasteAfterTranscribe.checked = true;
    await saveAndRepaint({ pasteAfterTranscribe: true });
    hidePasteNotice();
    return;
  }
  showPasteNotice(false);
  watchForPastePermission();
}

/* --------------------------------------------------------------- actions --- */

/* Only what changed travels: sending the whole form meant a save triggered by one
 * control carried every field, including a prompt the user was still typing. */
async function savePatch(patch) {
  return saveAndRepaint(patch);
}

async function saveAndRepaint(patch) {
  const response = await saveSettings(patch);
  /* The saved setting is the truth: a draft that was refused, or that the store
   * rewrote, must not be shown as if it were in effect. */
  shortcutDraft = '';
  if (patch && patch.shortcut !== undefined) renderShortcut();
  if (response.pasteBlocked) showPasteNotice(false);
  if (response.warningKey) setFormStatus(response.warningKey, 'warn');
  else if (formStatus.kind === 'warn' && formStatus.key) formStatus = { key: null, vars: null, kind: '' };
  renderSettingsStatus();
  return response;
}

async function checkKey() {
  if (!F.apiKey.value.trim()) return;
  const result = await api.testKey(currentModel());
  if (!result.ok) {
    setFormStatus(result.errorKey || 'error.unexpected', 'error', result.errorVars);
    return;
  }
  /* It works now: the sentence about it not working was still on screen, because nothing
   * ever cleared a status the user had just disproved. */
  formStatus = { key: null, vars: null, kind: '' };
  renderSettingsStatus();
}

async function refreshModels() {
  F.refreshModels.disabled = true;
  try {
    const result = await api.listModels();
    if (!result.ok) {
      setFormStatus(result.errorKey || 'error.offline', 'error');
      return;
    }
    models = result.models;
    renderModels();
    renderSettingsStatus();
  } finally {
    F.refreshModels.disabled = false;
  }
}

/* ------------------------------------------------------------- shortcuts --- */

/* What the row says while the user is choosing, and what it says about the combination
 * the app is actually holding. The sentence used to go to the form's status line, which is
 * the last element of a scrolling form — off the screen on a laptop — so a refused
 * combination looked exactly like nothing happening. */
function setShortcutHint(key) {
  F.shortcutHint.hidden = !key;
  F.shortcutHint.textContent = key ? t(key) : '';
  if (key) F.shortcutHint.scrollIntoView({ block: 'nearest' });
}

function renderShortcutNotice() {
  if (capturingShortcut) return;
  /* The settings file can hold a combination the system is not holding — the key was taken
   * at launch, or something grabbed it since. Saying so here is the difference between "the
   * shortcut does nothing" and knowing why. */
  setShortcutHint(settings.shortcut && appState.shortcutHeld === false ? 'ui.shortcutNotHeld' : '');
}

function beginShortcutCapture() {
  if (capturingShortcut) return;
  capturingShortcut = true;
  F.shortcut.classList.add('capturing');
  setShortcutHint('');
  /* Stop the system handing this app the keys it already holds: otherwise the user presses
   * the combination they can see, the app consumes it, and the field never hears a thing. */
  if (api.suspendShortcutCapture) api.suspendShortcutCapture(true).catch(() => {});
  renderShortcut();
}

function endShortcutCapture() {
  if (!capturingShortcut) return;
  capturingShortcut = false;
  F.shortcut.classList.remove('capturing');
  if (api.suspendShortcutCapture) api.suspendShortcutCapture(false).catch(() => {});
  renderShortcut();
  renderShortcutNotice();
}

function onShortcutKeyDown(event) {
  if (!capturingShortcut) {
    if (event.key === 'Enter' || event.key === ' ') beginShortcutCapture();
    return;
  }
  if (event.key === 'Tab') return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    shortcutDraft = '';
    endShortcutCapture();
    return;
  }

  const result = GuyaAccelerator.fromKeyboardEvent(event);
  if (result.errorKey) {
    /* Beside the field the user is looking at, and the status line as well: one is where
     * their eyes are, the other is where the rest of the form's messages live. */
    setShortcutHint(result.errorKey);
    setFormStatus(result.errorKey, 'warn');
    return;
  }
  if (result.accelerator) {
    if (result.accelerator === settings.shortcut) {
      /* The combination already in force: say so instead of the screen not changing. */
      setShortcutHint('ui.shortcutSame');
      endShortcutCapture();
      return;
    }
    shortcutDraft = result.accelerator;
    setShortcutHint('');
    endShortcutCapture();
    saveAndRepaint({ shortcut: result.accelerator });
  }
}

/* ------------------------------------------------------------------ wire --- */

function on(node, event, handler) {
  node.addEventListener(event, handler);
}

/* Text fields commit when the user is done with them, never mid-keystroke, and they
 * commit only themselves: the form is not a document to be re-sent on every edit.
 *
 * And a field the user has not typed in cannot commit at all. What is in a field is not
 * evidence of what the user wants unless they put it there: a field still empty because
 * the form had not been painted yet wrote that emptiness over the real value, which is
 * how an API key and a system prompt were lost. */
function commitOnBlur(input, after, patchOf) {
  let edited = false;
  on(input, 'input', () => {
    edited = true;
  });
  on(input, 'blur', async () => {
    if (!edited) {
      if (after) after();
      return;
    }
    edited = false;
    await saveAndRepaint(patchOf ? patchOf() : undefined);
    if (after) after();
  });
  /* Enter is how a one-line field is finished with. The system prompt is paragraphs of
   * instructions in a textarea, and there Enter is a newline — it committed the field and
   * took the focus away instead, so a line could only be added by pasting one. */
  if (input.tagName !== 'TEXTAREA') {
    on(input, 'keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });
  }
}

function initSettings() {
  on(F.toggleKey, 'click', () => {
    const hidden = F.apiKey.type === 'password';
    F.apiKey.type = hidden ? 'text' : 'password';
    F.toggleKeyIcon.setAttribute('href', hidden ? '#i-eye-off' : '#i-eye');
    F.toggleKey.setAttribute('aria-label', hidden ? t('ui.hideKey') : t('ui.showKey'));
  });

  commitOnBlur(F.apiKey, checkKey, () => ({ apiKey: F.apiKey.value.trim() }));
  commitOnBlur(F.prompt, null, () => ({ prompt: F.prompt.value }));
  commitOnBlur(F.modelCustom, renderModels, () => ({ model: currentModel() }));

  /* The field starts as the app's own instructions, and this is how they come back
   * after an edit — otherwise a deleted sentence would be gone for good. */
  on(F.resetPrompt, 'click', async () => {
    F.prompt.value = GuyaPrompt.DEFAULT_PROMPT;
    await saveAndRepaint({ prompt: F.prompt.value });
  });

  on(F.language, 'change', () => saveAndRepaint({ language: F.language.value }));
  on(F.silenceStop, 'change', () => {
    const isCustom = F.silenceStop.value === CUSTOM_MODEL;
    F.silenceCustom.hidden = !isCustom;
    F.silenceUnit.hidden = !isCustom;
    if (isCustom) {
      /* Starting from what is in force: the field kept the last number typed into it, so
       * re-opening "Custom…" and clicking away saved that instead of the row's value. */
      F.silenceCustom.value = String(secondsOf(settings.silenceStopMs));
      F.silenceCustom.focus();
    } else saveAndRepaint({ silenceStopMs: Number(F.silenceStop.value) });
  });
  on(F.noSpeechStop, 'change', () => {
    const isCustom = F.noSpeechStop.value === CUSTOM_MODEL;
    F.noSpeechCustom.hidden = !isCustom;
    F.noSpeechUnit.hidden = !isCustom;
    if (isCustom) {
      F.noSpeechCustom.value = String(secondsOf(settings.noSpeechStopMs));
      F.noSpeechCustom.focus();
    } else saveAndRepaint({ noSpeechStopMs: Number(F.noSpeechStop.value) });
  });
  commitOnBlur(F.silenceCustom, () => saveAndRepaint({ silenceStopMs: durationValue(F.silenceStop, F.silenceCustom, settings.silenceStopMs) }));
  commitOnBlur(F.noSpeechCustom, () => saveAndRepaint({ noSpeechStopMs: durationValue(F.noSpeechStop, F.noSpeechCustom, settings.noSpeechStopMs) }));
  on(F.attempts, 'change', () => saveAndRepaint({ attempts: Number(F.attempts.value) }));
  on(F.uiLanguageSelect, 'change', async () => {
    await saveSettings(Object.assign(currentFormPatch(), { uiLanguage: F.uiLanguageSelect.value }));
    shortcutDraft = '';
    const info = await api.getAppInfo();
    settings = info.settings;
    appState = info.state;
    applyAccent();
    applyI18n();
  });

  on(F.modelSelect, 'change', () => {
    if (F.modelSelect.value === CUSTOM_MODEL) {
      F.modelCustom.hidden = false;
      F.modelCustom.focus();
      return;
    }
    F.modelCustom.hidden = true;
    saveAndRepaint({ model: F.modelSelect.value });
  });

  on(F.shortcutRow, 'click', beginShortcutCapture);
  on(F.shortcut, 'focus', beginShortcutCapture);
  on(F.shortcut, 'blur', endShortcutCapture);
  on(F.shortcut, 'keydown', onShortcutKeyDown);
  on(F.refreshModels, 'click', refreshModels);
  on(F.openKeyPage, 'click', () => {
    if (api.openExternal) api.openExternal('aistudio');
  });

  on(F.pasteAfterTranscribe, 'change', async () => {
    try {
      if (F.pasteAfterTranscribe.checked) {
        if (!pasteSupport.supported) {
          F.pasteAfterTranscribe.checked = false;
          setFormStatus('settings.pasteNeedsTool', 'warn');
          return;
        }
        const status = await api.accessibilityStatus();
        if (!status.granted) {
          F.pasteAfterTranscribe.checked = false;
          showPasteNotice(false);
          await askForPastePermission();
          return;
        }
      }
      await saveAndRepaint({ pasteAfterTranscribe: F.pasteAfterTranscribe.checked });
    } catch (_) {
      F.pasteAfterTranscribe.checked = !!settings.pasteAfterTranscribe;
      setFormStatus('error.unexpected', 'error');
    }
  });

  on(F.openAccessibility, 'click', () => {
    api.openPrivacySettings('accessibility');
    watchForPastePermission();
  });
  on(F.askAccessibility, 'click', askForPastePermission);

  on(F.copyToClipboard, 'change', () => saveAndRepaint({ copyToClipboard: F.copyToClipboard.checked }));
  on(F.launchAtLogin, 'change', () => saveAndRepaint({ launchAtLogin: F.launchAtLogin.checked }));

  /* Only where there is no menu bar: macOS has Cmd+Q for this. */
  if (api.platform !== 'darwin') F.quitFootnote.hidden = false;
  on(F.quitApp, 'click', () => api.quit());

  /* The form is not painted here: this script runs before the shell has read the
   * settings, so a paint now draws empty selects and a duration field with no number in
   * it for a frame. The shell paints as soon as it has the answer. */
}

/* Called by the shell every time the settings screen is opened. */
window.__refreshSettings = async function refreshSettings() {
  /* Opening this screen is the moment to ask the system for the shortcut again: the
   * combination may have been taken when the app started and given back since, and this is
   * where the answer is shown. The main process pushes the new state, which repaints. */
  if (api.retryShortcut) api.retryShortcut().catch(() => {});
  try {
    applyPasteSupport(await api.pasteSupport());
    if (!pasteSupport.supported) {
      hidePasteNotice();
      return;
    }
  } catch (_) {
    /* keep the last answer */
  }
  let status = { granted: true };
  try {
    status = await api.accessibilityStatus();
  } catch (_) {
    return;
  }
  if (status.granted) {
    hidePasteNotice();
    return;
  }
  if (settings.pasteAfterTranscribe) {
    // The permission was revoked in System Settings: the setting cannot stand.
    F.pasteAfterTranscribe.checked = false;
    await saveAndRepaint({ pasteAfterTranscribe: false });
  }
  if (!F.pasteNotice.hidden) watchForPastePermission();
};

/* This script loads after the shell: wire up, and hand the shell these by reference. */
initSettings();
window.__repaintSettings = repaintSettings;
window.__renderFormStatus = renderSettingsStatus;
window.__renderShortcutNotice = renderShortcutNotice;

/* The shell's own paint is one of the two ways this form is drawn, and it may have
 * already happened — the shell awaits the settings, and that answer can arrive before
 * this script does. If it has the data, draw now. */
if (window.__shellReady) repaintSettings();

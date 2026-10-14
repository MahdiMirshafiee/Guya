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
  shortcut: document.getElementById('shortcut'),
  silenceStop: document.getElementById('silenceStop'),
  attempts: document.getElementById('attempts'),
  copyToClipboard: document.getElementById('copyToClipboard'),
  pasteAfterTranscribe: document.getElementById('pasteAfterTranscribe'),
  launchAtLogin: document.getElementById('launchAtLogin'),
  uiLanguageSelect: document.getElementById('uiLanguageSelect'),
  pasteFootnote: document.getElementById('pasteFootnote'),
  pasteNotice: document.getElementById('pasteNotice'),
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

function currentFormPatch() {
  return {
    apiKey: F.apiKey.value.trim(),
    model: currentModel(),
    language: F.language.value,
    prompt: F.prompt.value,
    uiLanguage: F.uiLanguageSelect.value || settings.uiLanguage,
    silenceStopMs: Number(F.silenceStop.value),
    attempts: Number(F.attempts.value),
    shortcut: shortcutDraft || settings.shortcut,
    copyToClipboard: F.copyToClipboard.checked,
    pasteAfterTranscribe: F.pasteAfterTranscribe.checked,
    launchAtLogin: F.launchAtLogin.checked
  };
}

/* A curated list plus a final "Custom…" entry: provider model names change
 * faster than releases, so a closed list would rot, and a bare text field would
 * make the common case worse. */
function renderModels() {
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

  const current = String(settings.silenceStopMs);
  F.silenceStop.innerHTML = '';
  (appState.silenceChoices || [10000]).forEach((ms) => {
    const option = document.createElement('option');
    option.value = String(ms);
    option.textContent = ms === 0
      ? t('ui.silenceOff')
      : t('ui.secondsShort', { count: new Intl.NumberFormat(language).format(ms / 1000) });
    F.silenceStop.appendChild(option);
  });
  F.silenceStop.value = current;

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
  GuyaAccelerator.displayParts(shortcutDraft || settings.shortcut).forEach((part) => {
    const key = document.createElement('kbd');
    key.className = 'key';
    key.textContent = part;
    F.shortcut.appendChild(key);
  });
}

/* Called by the shell (which loads first) through window.__repaintSettings. */
function repaintSettings() {
  F.apiKey.value = settings.apiKey || '';
  F.prompt.value = settings.prompt || '';
  F.copyToClipboard.checked = !!settings.copyToClipboard;
  F.pasteAfterTranscribe.checked = !!settings.pasteAfterTranscribe;
  F.launchAtLogin.checked = !!settings.launchAtLogin;
  F.toggleKey.setAttribute('aria-label', F.apiKey.type === 'password' ? t('ui.showKey') : t('ui.hideKey'));

  applyPasteSupport(pasteSupport);
  F.refreshModels.setAttribute('aria-label', t('ui.refreshModels'));
  renderLanguages();
  renderModels();
  renderShortcut();
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
    await saveAndRepaint();
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
    await saveAndRepaint();
    hidePasteNotice();
    return;
  }
  showPasteNotice(false);
  watchForPastePermission();
}

/* --------------------------------------------------------------- actions --- */

async function saveAndRepaint(patch) {
  const response = await saveSettings(patch);
  if (response.pasteBlocked) showPasteNotice(false);
  if (response.warningKey) setFormStatus(response.warningKey, 'warn');
  else if (formStatus.kind === 'warn' && formStatus.key) formStatus = { key: null, vars: null, kind: '' };
  renderSettingsStatus();
  return response;
}

async function checkKey() {
  if (!F.apiKey.value.trim()) return;
  const result = await api.testKey(currentModel());
  if (!result.ok) setFormStatus(result.errorKey || 'error.unexpected', 'error', result.errorVars);
  else renderSettingsStatus();
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

function beginShortcutCapture() {
  if (capturingShortcut) return;
  capturingShortcut = true;
  F.shortcut.classList.add('capturing');
  renderShortcut();
}

function endShortcutCapture() {
  capturingShortcut = false;
  F.shortcut.classList.remove('capturing');
  renderShortcut();
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
    setFormStatus(result.errorKey, 'warn');
    return;
  }
  if (result.accelerator) {
    shortcutDraft = result.accelerator;
    endShortcutCapture();
    saveAndRepaint();
  }
}

/* ------------------------------------------------------------------ wire --- */

function on(node, event, handler) {
  node.addEventListener(event, handler);
}

/* Text fields commit when the user is done with them, never mid-keystroke. */
function commitOnBlur(input, after) {
  on(input, 'blur', async () => {
    await saveAndRepaint();
    if (after) after();
  });
  on(input, 'keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
}

function initSettings() {
  on(F.toggleKey, 'click', () => {
    const hidden = F.apiKey.type === 'password';
    F.apiKey.type = hidden ? 'text' : 'password';
    F.toggleKeyIcon.setAttribute('href', hidden ? '#i-eye-off' : '#i-eye');
    F.toggleKey.setAttribute('aria-label', hidden ? t('ui.hideKey') : t('ui.showKey'));
  });

  commitOnBlur(F.apiKey, checkKey);
  commitOnBlur(F.prompt);
  commitOnBlur(F.modelCustom, renderModels);

  on(F.language, 'change', () => saveAndRepaint());
  on(F.silenceStop, 'change', () => saveAndRepaint());
  on(F.attempts, 'change', () => saveAndRepaint());
  on(F.uiLanguageSelect, 'change', async () => {
    await saveSettings(Object.assign(currentFormPatch(), { uiLanguage: F.uiLanguageSelect.value }));
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
    saveAndRepaint();
  });

  on(F.shortcut, 'focus', beginShortcutCapture);
  on(F.shortcut, 'click', beginShortcutCapture);
  on(F.shortcut, 'blur', endShortcutCapture);
  on(F.shortcut, 'keydown', onShortcutKeyDown);
  on(F.refreshModels, 'click', refreshModels);

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
      await saveAndRepaint();
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

  [F.copyToClipboard, F.launchAtLogin].forEach((input) => {
    on(input, 'change', () => saveAndRepaint());
  });

  // Seed the picker with the curated suggestions; "Refresh models" replaces them
  // with what the key can actually use.
  if (!models.length && appState.knownModels) models = appState.knownModels.map((id) => ({ id }));

  repaintSettings();
}

/* Called by the shell every time the settings screen is opened. */
window.__refreshSettings = async function refreshSettings() {
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
    await saveAndRepaint();
  }
  if (!F.pasteNotice.hidden) watchForPastePermission();
};

/* This script loads after the shell, so wire up and paint as soon as it runs. */
initSettings();

/* The shell runs first and calls these by reference. */
window.__repaintSettings = repaintSettings;
window.__renderFormStatus = renderSettingsStatus;

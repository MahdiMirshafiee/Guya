/*
 * Unit tests for everything that can run outside Electron: the audio pipeline,
 * accelerator parsing, settings persistence and the Gemini client (with a
 * stubbed fetch). Run with `npm test`.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

/* ------------------------------------------------------- electron stub ----- */

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2t-test-'));
const fakeElectron = {
  app: {
    getPath: () => userDataDir,
    getVersion: () => '1.0.0',
    isPackaged: false,
    on: () => {},
    dock: null
  },
  clipboard: { writeText: () => {} },
  systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true },
  shell: { openExternal: () => Promise.resolve() }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.apply(this, arguments);
};

const GuyaAudio = require('../src/shared/audio.js');
const GuyaAccelerator = require('../src/shared/accelerator.js');
const GuyaI18n = require('../src/shared/i18n.js');
const GuyaBidi = require('../src/shared/bidi.js');
const store = require('../src/main/store.js');
const gemini = require('../src/main/gemini.js');

/* ------------------------------------------------------------- harness ---- */

let passed = 0;
let failed = 0;
let queue = Promise.resolve();

function test(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      passed++;
      console.log('  \u001b[32m✓\u001b[0m ' + name);
    } catch (err) {
      failed++;
      console.log('  \u001b[31m✗\u001b[0m ' + name);
      console.log('      ' + (err && err.message ? err.message : err));
    }
  });
}

function group(name) {
  queue = queue.then(() => console.log('\n' + name));
}

function sine(freq, seconds, rate, amplitude) {
  const length = Math.round(seconds * rate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = (amplitude === undefined ? 0.5 : amplitude) * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function readAscii(view, offset, length) {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

function wavView(wav) {
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
}

/* ============================================================== audio ==== */

group('audio');

test('floatToInt16 clips and scales', () => {
  const out = GuyaAudio.floatToInt16(new Float32Array([0, 1, -1, 2, -3, 0.5]));
  assert.strictEqual(out[0], 0);
  assert.strictEqual(out[1], 32767);
  assert.strictEqual(out[2], -32768);
  assert.strictEqual(out[3], 32767, 'positive overflow clamps');
  assert.strictEqual(out[4], -32768, 'negative overflow clamps');
  assert.strictEqual(out[5], 16383);
});

test('resample keeps duration and frequency', () => {
  const input = sine(440, 1, 48000);
  const output = GuyaAudio.resample(input, 48000, 16000);
  assert.strictEqual(output.length, 16000, 'one second stays one second');

  let crossings = 0;
  for (let i = 1; i < output.length; i++) if (output[i - 1] < 0 !== output[i] < 0) crossings++;
  assert.ok(Math.abs(crossings - 880) <= 2, `expected ~880 zero crossings, got ${crossings}`);
});

test('resample passes through at equal rates', () => {
  const input = sine(200, 0.05, 16000);
  assert.strictEqual(GuyaAudio.resample(input, 16000, 16000), input);
});

test('encodeWav writes a valid 16 kHz mono header', () => {
  const samples = new Int16Array(16000);
  const wav = GuyaAudio.encodeWav(samples, 16000);
  const view = wavView(wav);
  assert.strictEqual(wav.length, 44 + 32000);
  assert.strictEqual(readAscii(view, 0, 4), 'RIFF');
  assert.strictEqual(view.getUint32(4, true), 36 + 32000);
  assert.strictEqual(readAscii(view, 8, 4), 'WAVE');
  assert.strictEqual(readAscii(view, 12, 4), 'fmt ');
  assert.strictEqual(view.getUint32(16, true), 16);
  assert.strictEqual(view.getUint16(20, true), 1, 'PCM');
  assert.strictEqual(view.getUint16(22, true), 1, 'mono');
  assert.strictEqual(view.getUint32(24, true), 16000);
  assert.strictEqual(view.getUint32(28, true), 32000, 'byte rate');
  assert.strictEqual(view.getUint16(32, true), 2, 'block align');
  assert.strictEqual(view.getUint16(34, true), 16, 'bits per sample');
  assert.strictEqual(readAscii(view, 36, 4), 'data');
  assert.strictEqual(view.getUint32(40, true), 32000);
});

test('wavFromFloat32 resamples 44.1 kHz input to 16 kHz', () => {
  const wav = GuyaAudio.wavFromFloat32(sine(440, 2, 44100), 44100);
  assert.strictEqual((wav.length - 44) / 2, 32000, 'two seconds at 16 kHz');
  assert.ok(Math.abs(GuyaAudio.durationSeconds(wav.length) - 2) < 1e-9, 'durationSeconds matches the audio length');
});

test('wavFromFloat32 keeps amplitude', () => {
  const wav = GuyaAudio.wavFromFloat32(sine(300, 0.5, 48000, 0.5), 48000);
  const data = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  // 0.5 amplitude lands exactly on 16383.5, which Int16Array rounds up.
  assert.ok(peak === 16383 || peak === 16384, `0.5 amplitude should map to 0.5 * 32767, got ${peak}`);
});

test('rms and concat behave', () => {
  assert.strictEqual(GuyaAudio.rms(new Float32Array(0)), 0);
  const half = GuyaAudio.rms(new Float32Array([0.5, -0.5, 0.5, -0.5]));
  assert.ok(Math.abs(half - 0.5) < 1e-6);
  const joined = GuyaAudio.concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]);
  assert.deepStrictEqual(Array.from(joined), [1, 2, 3]);
});

/* ======================================================== accelerator ==== */

group('accelerator');

function keyEvent(overrides) {
  return Object.assign({ key: 'Space', code: 'Space', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, overrides);
}

test('primary modifier maps to CommandOrControl on macOS', () => {
  GuyaAccelerator.setPlatform('darwin');
  const result = GuyaAccelerator.fromKeyboardEvent(keyEvent({ metaKey: true, shiftKey: true }));
  assert.strictEqual(result.accelerator, 'CommandOrControl+Shift+Space');
});

test('primary modifier maps to CommandOrControl on Windows', () => {
  GuyaAccelerator.setPlatform('win32');
  const result = GuyaAccelerator.fromKeyboardEvent(keyEvent({ ctrlKey: true, shiftKey: true }));
  assert.strictEqual(result.accelerator, 'CommandOrControl+Shift+Space');
});

test('letters and digits are read from event.code', () => {
  GuyaAccelerator.setPlatform('darwin');
  assert.strictEqual(GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: 'd', code: 'KeyD', metaKey: true })).accelerator, 'CommandOrControl+D');
  assert.strictEqual(GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: '7', code: 'Digit7', altKey: true })).accelerator, 'Alt+7');
  assert.strictEqual(GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: 'F9', code: 'F9' })).accelerator, 'F9');
});

test('punctuation and shifted punctuation are captured', () => {
  GuyaAccelerator.setPlatform('darwin');
  assert.strictEqual(
    GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: '<', code: 'Comma', metaKey: true, shiftKey: true })).accelerator,
    'CommandOrControl+Shift+,'
  );
  assert.strictEqual(
    GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: '/', code: 'Slash', altKey: true })).accelerator,
    'Alt+/'
  );
  assert.strictEqual(
    GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true })).accelerator,
    'Super+Up'
  );
});

test('bare letters are rejected, function keys are not', () => {
  const rejected = GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: 'd', code: 'KeyD' }));
  assert.ok(rejected.errorKey && !rejected.accelerator);
  const allowed = GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: 'F9', code: 'F9' }));
  assert.strictEqual(allowed.accelerator, 'F9');
});

test('modifier-only presses are ignored', () => {
  const result = GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: 'Meta', code: 'MetaLeft', metaKey: true }));
  assert.strictEqual(result.errorKey, undefined);
  assert.strictEqual(result.accelerator, undefined);
});

test('reserved combinations are rejected', () => {
  GuyaAccelerator.setPlatform('darwin');
  const quit = GuyaAccelerator.fromKeyboardEvent(keyEvent({ key: 'q', code: 'KeyQ', metaKey: true }));
  assert.strictEqual(quit.errorKey, 'ui.shortcutReserved', 'Command+Q must not be grabbed globally');
});

test('display formats per platform', () => {
  GuyaAccelerator.setPlatform('darwin');
  assert.strictEqual(GuyaAccelerator.display('CommandOrControl+Shift+Space'), '⇧⌘Space');
  GuyaAccelerator.setPlatform('win32');
  assert.strictEqual(GuyaAccelerator.display('CommandOrControl+Shift+Space'), 'Ctrl+Shift+Space');
  assert.strictEqual(GuyaAccelerator.display('Alt+F9'), 'Alt+F9');
});

/* ============================================================== store ==== */

group('settings store');

test('defaults are complete', () => {
  const settings = store.read();
  assert.strictEqual(settings.model, 'gemini-2.5-flash');
  assert.strictEqual(settings.language, 'auto');
  assert.strictEqual(settings.uiLanguage, 'fa');
  assert.strictEqual(settings.copyToClipboard, true);
  assert.strictEqual(settings.pasteAfterTranscribe, false);
  assert.ok(settings.shortcut.indexOf('CommandOrControl') === 0);
});

test('the silence stop only accepts the offered durations', () => {
  assert.strictEqual(store.read().silenceStopMs, 10000, 'sensible default');
  assert.strictEqual(store.update({ silenceStopMs: 3000 }).silenceStopMs, 3000);
  assert.strictEqual(store.update({ silenceStopMs: 4242 }).silenceStopMs, 3000, 'junk keeps the previous value');
  assert.strictEqual(store.update({ silenceStopMs: 0 }).silenceStopMs, 0, 'off is a real choice');
  store.update({ silenceStopMs: 10000 });
});

test('uiLanguage only accepts fa or en', () => {
  assert.strictEqual(store.update({ uiLanguage: 'en' }).uiLanguage, 'en');
  assert.strictEqual(store.update({ uiLanguage: 'klingon' }).uiLanguage, 'en', 'previous value survives junk');
  assert.strictEqual(store.update({ uiLanguage: 'fa' }).uiLanguage, 'fa');
});

test('update persists and reloads from disk', () => {
  store.update({ apiKey: '  key-123  ', model: 'gemini-2.5-pro' });
  const onDisk = JSON.parse(fs.readFileSync(store.path, 'utf8'));
  assert.strictEqual(onDisk.apiKey, 'key-123', 'keys are trimmed');
  assert.strictEqual(onDisk.model, 'gemini-2.5-pro');
});

test('bad values fall back to defaults', () => {
  const settings = store.update({ language: 'klingon', shortcut: 'not a shortcut!', apiKey: 42, prompt: 'x'.repeat(9000) });
  assert.strictEqual(settings.language, 'auto');
  assert.strictEqual(settings.apiKey, 'key-123', 'non-string keys are ignored');
  assert.strictEqual(settings.prompt.length, 4000, 'prompt is truncated');
  assert.ok(/^[A-Za-z0-9+]+$/.test(settings.shortcut));
});

test('unknown fields are dropped', () => {
  const settings = store.update({ somethingElse: true });
  assert.strictEqual(settings.somethingElse, undefined);
});

/* ============================================================= gemini ==== */

group('gemini client');

const realFetch = globalThis.fetch;
let lastRequest = null;

function stubFetch(handler) {
  globalThis.fetch = async (url, options) => {
    lastRequest = { url: String(url), options };
    const result = handler(String(url), options);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => JSON.stringify(result.body)
    };
  };
}

function validWav() {
  return GuyaAudio.wavFromFloat32(sine(440, 0.2, 16000), 16000);
}

test('flash models are asked without extended thinking', async () => {
  stubFetch(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }));
  await gemini.transcribe({ apiKey: 'k', model: 'gemini-2.5-flash', wav: validWav(), settings: {} });
  const body = JSON.parse(lastRequest.options.body);
  assert.deepStrictEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, 'thinking costs seconds for no gain');

  stubFetch(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }));
  await gemini.transcribe({ apiKey: 'k', model: 'gemini-2.5-pro', wav: validWav(), settings: {} });
  assert.strictEqual(JSON.parse(lastRequest.options.body).generationConfig.thinkingConfig, undefined, 'pro rejects a zero budget');
});

test('a rejected thinking config is retried without it', async () => {
  let calls = 0;
  stubFetch(() => {
    calls++;
    if (calls === 1) {
      const sent = JSON.parse(lastRequest.options.body);
      assert.ok(sent.generationConfig.thinkingConfig, 'first attempt asks without thinking');
      return { status: 400, body: { error: { message: 'thinkingConfig is not supported' } } };
    }
    assert.strictEqual(JSON.parse(lastRequest.options.body).generationConfig.thinkingConfig, undefined);
    return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'بدون thinking' }] } }] } };
  });
  const result = await gemini.transcribe({ apiKey: 'k', model: 'gemini-2.5-flash', wav: validWav(), settings: {} });
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.text, 'بدون thinking');
});

test('several attempts are made, and each one is reported', async () => {
  const notes = [];
  let calls = 0;
  stubFetch(() => {
    calls++;
    if (calls < 3) return { status: 503, body: { error: { message: 'unavailable' } } };
    return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'بالاخره' }] } }] } };
  });
  const result = await gemini.transcribe({
    apiKey: 'k', model: 'm', wav: validWav(), settings: { attempts: 3 },
    onAttempt: (attempt, total) => notes.push([attempt, total])
  });
  assert.strictEqual(calls, 3, 'it keeps trying');
  assert.deepStrictEqual(notes, [[2, 3], [3, 3]], 'the screen can say which attempt is running');
  assert.strictEqual(result.text, 'بالاخره');
});

test('a hopeless failure is not retried', async () => {
  let calls = 0;
  stubFetch(() => {
    calls++;
    return { status: 403, body: { error: { message: 'permission denied' } } };
  });
  await gemini.transcribe({ apiKey: 'k', model: 'm', wav: validWav(), settings: { attempts: 5 } });
  assert.strictEqual(calls, 1, 'a rejected key will be rejected again');
});

test('the system prompt is a real system instruction', async () => {
  stubFetch(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }));
  await gemini.transcribe({ apiKey: 'k', model: 'gemini-2.5-flash', wav: validWav(), seconds: 12, settings: { language: 'fa' } });
  const body = JSON.parse(lastRequest.options.body);
  assert.ok(body.systemInstruction.parts[0].text.includes('رونویسی'), 'the job description is in systemInstruction');
  assert.ok(body.systemInstruction.parts[0].text.includes('فارسی'), 'and it knows the spoken language');
  assert.ok(body.contents[0].parts[0].text.length < 120, 'the user turn stays short');
  assert.ok(body.generationConfig.maxOutputTokens >= 96 && body.generationConfig.maxOutputTokens < 1000, 'the answer is capped to the audio length');
});

test('the output cap grows with the recording', () => {
  assert.ok(gemini.outputCap(3) < gemini.outputCap(60));
  assert.ok(gemini.outputCap(100000) <= 8192);
});

test('transcribe posts inline audio and returns the text', async () => {
  stubFetch(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'سلام دنیا' }] }, finishReason: 'STOP' }] } }));
  const result = await gemini.transcribe({
    apiKey: 'k',
    model: 'gemini-2.5-flash',
    wav: validWav(),
    settings: { prompt: 'دقیق بنویس', language: 'fa' }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.text, 'سلام دنیا');
  assert.ok(lastRequest.url.includes('/models/gemini-2.5-flash:generateContent'));
  assert.strictEqual(lastRequest.options.headers['x-goog-api-key'], 'k');

  const body = JSON.parse(lastRequest.options.body);
  const parts = body.contents[0].parts;
  assert.strictEqual(parts[1].inlineData.mimeType, 'audio/wav');
  assert.strictEqual(Buffer.from(parts[1].inlineData.data, 'base64').length, validWav().length, 'audio survives base64');
  assert.ok(parts[0].text.includes('دقیق بنویس'), 'custom instructions are kept');
  assert.ok(parts[0].text.includes('فارسی'), 'language hint is added');
  assert.strictEqual(body.generationConfig.temperature, 0);
});

test('transcribe strips whitespace and flags truncation', async () => {
  stubFetch(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: '  متن  ' }] }, finishReason: 'MAX_TOKENS' }] } }));
  const result = await gemini.transcribe({ apiKey: 'k', model: 'm', wav: validWav(), settings: {} });
  assert.strictEqual(result.text, 'متن');
  assert.strictEqual(result.truncated, true);
});

test('transcribe does not retry a bad key', async () => {
  let calls = 0;
  stubFetch(() => {
    calls++;
    return { status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } };
  });
  const result = await gemini.transcribe({ apiKey: 'nope', model: 'm', wav: validWav(), settings: {} });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorKey, 'error.badKey');
  assert.strictEqual(result.error, GuyaI18n.t('fa', 'error.badKey'));
  assert.strictEqual(calls, 1);
});

test('transcribe retries once on rate limiting', async () => {
  let calls = 0;
  stubFetch(() => {
    calls++;
    return calls === 1
      ? { status: 429, body: { error: { message: 'quota' } } }
      : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'بعد از تلاش دوم' }] } }] } };
  });
  const result = await gemini.transcribe({ apiKey: 'k', model: 'm', wav: validWav(), settings: {} });
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.text, 'بعد از تلاش دوم');
});

test('missing candidates and safety blocks become errors', async () => {
  stubFetch(() => ({ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }));
  const blocked = await gemini.transcribe({ apiKey: 'k', model: 'm', wav: validWav(), settings: {} });
  assert.strictEqual(blocked.ok, false);

  stubFetch(() => ({ status: 200, body: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] } }));
  const empty = await gemini.transcribe({ apiKey: 'k', model: 'm', wav: validWav(), settings: {} });
  assert.strictEqual(empty.errorKey, 'error.noSpeech');
});

test('transcribe refuses to run without a key or model', async () => {
  const noKey = await gemini.transcribe({ apiKey: '', model: 'm', wav: validWav(), settings: {} });
  assert.strictEqual(noKey.ok, false);
  const noModel = await gemini.transcribe({ apiKey: 'k', model: '', wav: validWav(), settings: {} });
  assert.strictEqual(noModel.ok, false);
});

test('listModels keeps only generateContent models, flash first', async () => {
  stubFetch(() => ({
    status: 200,
    body: {
      models: [
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-pro', displayName: 'Pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-lite', displayName: 'Lite', supportedGenerationMethods: ['generateContent'] }
      ]
    }
  }));
  const result = await gemini.listModels('k');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    result.models.map((m) => m.id),
    ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
  );
  assert.strictEqual(lastRequest.url.includes('pageSize=200'), true);
});

test('testKey reports model errors as keys and localized text', async () => {
  stubFetch(() => ({ status: 404, body: { error: { message: 'model not found' } } }));
  const result = await gemini.testKey('k', 'nope', 'en');
  assert.strictEqual(result.errorKey, 'error.modelMissing');
  assert.strictEqual(result.error, GuyaI18n.t('en', 'error.modelMissing'));

  stubFetch(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }));
  assert.strictEqual((await gemini.testKey('k', 'm')).ok, true);
});

test('no user-visible string is hardcoded', () => {
  const root = path.join(__dirname, '..');
  /* Every source file except the dictionary itself. */
  const files = [];
  ['src/main', 'src/renderer', 'src/preload', 'src/shared'].forEach((dir) => {
    fs.readdirSync(path.join(root, dir)).forEach((name) => {
      if (!/\.(js|html|css)$/.test(name)) return;
      if (name === 'i18n.js') return;
      files.push(path.join(dir, name));
    });
  });
  assert.ok(files.length > 12, 'the audit should cover the whole source tree');

  files.forEach((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/[\u0600-\u06FF]/.test(source), file + ' carries non-Latin text outside the dictionary');
    // not the data-i18n-* forms: those carry a key, not a string
    const attribute = /(?<![-\w])(aria-label|placeholder)="[^"]*[A-Za-z][^"]*"/.exec(source);
    assert.ok(!attribute, file + ' has the hardcoded attribute ' + (attribute && attribute[0]));
  });

  // every key the markup asks for must exist, or the UI would show a raw key
  const html = fs.readFileSync(path.join(root, 'src/renderer/panel.html'), 'utf8');
  const keys = Array.from(html.matchAll(/data-i18n(?:-placeholder|-label)?="([^"]+)"/g)).map((m) => m[1]);
  assert.ok(keys.length > 15, 'the markup should be driven by keys, found ' + keys.length);
  keys.forEach((key) => {
    assert.ok(GuyaI18n.MESSAGES[key], 'missing translation for ' + key);
  });
});

test('both languages render every key without leftovers from the other', () => {
  const persian = /[\u0600-\u06FF]/;
  Object.keys(GuyaI18n.MESSAGES).forEach((key) => {
    const entry = GuyaI18n.MESSAGES[key];
    assert.ok(!persian.test(entry.en), key + ' leaks Persian script into the English string');
    assert.ok(!/[\u0600-\u06FF]/.test(GuyaI18n.t('en', key).replace(/\{[a-z]+\}/g, '')), key + ' resolves to Persian in English');
  });
  assert.strictEqual(GuyaI18n.t('en', 'ui.engineName'), 'Gemini');
  assert.strictEqual(GuyaI18n.t('fa', 'ui.engineName'), 'Gemini');
});

/* =============================================================== bidi ==== */

group('transcript direction');

test('a Persian sentence reads right-to-left', () => {
  assert.strictEqual(GuyaBidi.directionOf('این یک یادداشت کوتاه است.'), 'rtl');
});

test('an English sentence reads left-to-right', () => {
  assert.strictEqual(GuyaBidi.directionOf('A short note before the meeting.'), 'ltr');
});

test('an English word first does not drag the paragraph left', () => {
  assert.strictEqual(GuyaBidi.directionOf('OK حالا برویم سراغ جلسه فردا'), 'rtl');
  assert.strictEqual(GuyaBidi.directionOf('Design review جلسه'), 'ltr', 'the majority still wins');
});

test('the dominant language wins in mixed text', () => {
  assert.strictEqual(GuyaBidi.directionOf('این جمله فارسی است و فقط یک کلمه English دارد'), 'rtl');
  assert.strictEqual(GuyaBidi.directionOf('This sentence is English with one واژه in it'), 'ltr');
});

test('numbers and punctuation follow the interface around them', () => {
  assert.strictEqual(GuyaBidi.directionOf('1234 ... 5678', 'ltr'), 'ltr');
  assert.strictEqual(GuyaBidi.directionOf('۱۲۳۴ ...', 'rtl'), 'rtl');
  assert.strictEqual(GuyaBidi.directionOf('', 'rtl'), 'rtl');
  assert.strictEqual(GuyaBidi.directionOf('   ', 'ltr'), 'ltr');
});

test('paragraphs are split where the speaker paused', () => {
  const blocks = GuyaBidi.blocksOf('خط اول\n\nخط دوم\n  \nخط سوم');
  assert.deepStrictEqual(blocks, ['خط اول', 'خط دوم', 'خط سوم']);
  assert.deepStrictEqual(GuyaBidi.blocksOf(''), []);
  assert.deepStrictEqual(GuyaBidi.blocksOf(null), []);
});

/* =============================================================== i18n ==== */

group('i18n');

test('every message exists in both languages', () => {
  const keys = Object.keys(GuyaI18n.MESSAGES);
  assert.ok(keys.length > 40, `expected a full dictionary, got ${keys.length} keys`);
  keys.forEach((key) => {
    const entry = GuyaI18n.MESSAGES[key];
    assert.ok(entry.fa && entry.fa.length, key + ' is missing the Persian text');
    assert.ok(entry.en && entry.en.length, key + ' is missing the English text');
  });
});

test('placeholders are substituted', () => {
  assert.strictEqual(GuyaI18n.t('fa', 'error.http', { status: 404 }), 'خطای HTTP 404');
  assert.strictEqual(GuyaI18n.t('en', 'error.http', { status: 500 }), 'HTTP error 500');
});

test('unknown keys fall back to the key itself', () => {
  assert.strictEqual(GuyaI18n.t('en', 'nope.missing'), 'nope.missing');
});

test('spoken language labels are localized', () => {
  assert.strictEqual(GuyaI18n.languageLabel('fa', 'en'), 'Persian');
  assert.strictEqual(GuyaI18n.languageLabel('fa', 'fa'), 'فارسی');
  assert.strictEqual(GuyaI18n.languageLabel('en', 'en'), 'English');
  assert.strictEqual(GuyaI18n.languageLabel('en', undefined), 'انگلیسی');
});

test('unknown UI languages fall back to Persian', () => {
  assert.strictEqual(GuyaI18n.normalizeLanguage('de'), 'fa');
  assert.strictEqual(GuyaI18n.normalizeLanguage(undefined), 'fa');
  assert.strictEqual(GuyaI18n.normalizeLanguage('en'), 'en');
});

test('the system prompt is a real job description in both languages', () => {
  ['fa', 'en'].forEach((lang) => {
    const prompt = GuyaI18n.SYSTEM_PROMPTS[lang];
    assert.ok(prompt.length > 300, lang + ' prompt is too thin');
    assert.ok(prompt.indexOf('Rules') !== -1 || prompt.indexOf('قواعد') !== -1, lang + ' prompt has no rules');
  });
  assert.notStrictEqual(GuyaI18n.SYSTEM_PROMPTS.fa, GuyaI18n.SYSTEM_PROMPTS.en);
  assert.strictEqual(require('../src/shared/defaults.js').DEFAULTS.prompt, '', 'the field starts empty: the system prompt does the work');
});

test('a bundled instruction from an older install is cleared on load', () => {
  const legacy = GuyaI18n.LEGACY_PROMPTS.en;
  const file = store.path;
  const saved = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify(Object.assign({}, JSON.parse(saved), { prompt: legacy })));
  const storePath = require.resolve('../src/main/store.js');
  delete require.cache[storePath];
  const reloaded = require(storePath).read();
  assert.strictEqual(reloaded.prompt, '', 'the stale bundled text is dropped');
  fs.writeFileSync(file, saved);
});

test('the instruction follows the spoken and UI language', () => {
  const english = gemini.buildInstruction({ uiLanguage: 'en', language: 'fa', prompt: 'Keep names in Latin.' });
  assert.ok(english.indexOf('The audio is in Persian.') === 0, 'the language comes first');
  assert.ok(english.indexOf('Keep names in Latin.') !== -1, 'then whatever the user added');
  assert.strictEqual(gemini.buildInstruction({ uiLanguage: 'fa', language: 'auto', prompt: '' }), 'زبان گفتار را خودت تشخیص بده.');
  // the user's own words are additive and never replace the system prompt
  const withUser = gemini.systemInstruction({ uiLanguage: 'en', language: 'en', prompt: 'Ignore me' });
  assert.ok(withUser.indexOf('Ignore me') === -1, 'the user text is not part of the system prompt');
});

/* ------------------------------------------------------------- finish ---- */

queue.then(() => {
  globalThis.fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});

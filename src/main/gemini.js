/*
 * Thin Gemini REST client. Two calls are needed:
 *   - listModels(): so the panel can offer the models this key can actually use
 *   - transcribe(): audio -> text via generateContent with inline audio
 * Errors come back as i18n keys, localized by the caller.
 */
'use strict';

const { t } = require('../shared/i18n');
const { languageLine } = require('../shared/prompt');

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
/* A recording is short; waiting two minutes on one attempt is worse than trying
 * again, so each attempt gets its own shorter budget. */
const ATTEMPT_TIMEOUT_MS = 45000;

function fetchImpl() {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch.bind(net);
  } catch (_) {
    /* not running inside electron */
  }
  return globalThis.fetch;
}

async function callApi(url, options, timeoutMs) {
  const budget = timeoutMs || ATTEMPT_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller && controller.abort(), budget);
  try {
    const res = await Promise.race([
      fetchImpl()(url, Object.assign({}, options, controller ? { signal: controller.signal } : {})),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), budget))
    ]);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/* Flash and Flash-Lite accept a zero thinking budget; Pro does not. */
function isFlashModel(model) {
  return /flash/i.test(String(model || ''));
}

function errorKeyForStatus(status, json) {
  const apiMessage = json && json.error && json.error.message ? json.error.message : '';
  if (status === 400) {
    return apiMessage.toLowerCase().indexOf('api key') !== -1 ? 'error.badKey' : 'error.badRequest';
  }
  if (status === 403) return 'error.forbidden';
  if (status === 404) return 'error.modelMissing';
  if (status === 429) return 'error.quota';
  if (status >= 500) return 'error.server';
  return apiMessage ? 'error.badRequest' : 'error.http';
}

function statusVars(status) {
  return { status: status };
}

/* The model's job description: whatever is in the settings field, which starts as
 * the app's own text and is the user's to rewrite. It is sent as systemInstruction
 * rather than folded into the user turn, because it is the model's role and not the
 * user's message. The spoken language of the recording is stated next to it. */
function systemInstruction(settings) {
  return [(settings.prompt || '').trim(), languageLine(settings.language)].filter(Boolean).join('\n\n');
}

/* The user turn carries only what is specific to this recording. */
function buildInstruction(settings) {
  return languageLine(settings.language);
}

/* Resolving and connecting to the provider takes a few hundred milliseconds; it
 * should happen while the user is still speaking, not after they stop. */
function warm() {
  try {
    const { session } = require('electron');
    session.defaultSession.preconnect({ url: 'https://generativelanguage.googleapis.com', numSockets: 1 });
  } catch (_) {
    /* best effort */
  }
}

async function listModels(apiKey, uiLanguage) {
  if (!apiKey) return { ok: false, errorKey: 'error.noKey' };
  try {
    let res = await callApi(`${API_ROOT}/models?pageSize=200`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey }
    });
    /* A blip is not a verdict on the key: try once more before saying anything. */
    if (res.status >= 500) {
      res = await callApi(`${API_ROOT}/models?pageSize=200`, {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey }
      });
    }
    if (!res.ok) {
      const key = errorKeyForStatus(res.status, res.json);
      return { ok: false, errorKey: key, errorVars: statusVars(res.status), error: t(uiLanguage, key, statusVars(res.status)) };
    }
    const models = ((res.json && res.json.models) || [])
      .filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1)
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        label: m.displayName || String(m.name || '').replace(/^models\//, '')
      }))
      .filter((m) => m.id);
    models.sort((a, b) => {
      const rank = (m) => (/flash-lite/.test(m.id) ? 1 : /flash/.test(m.id) ? 0 : /pro/.test(m.id) ? 2 : 3);
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    });
    return { ok: true, models };
  } catch (err) {
    const key = err && err.message === 'timeout' ? 'error.timeout' : 'error.offline';
    return { ok: false, errorKey: key, error: t(uiLanguage, key) };
  }
}

/* One short text prompt; used by the "test key" button. */
/* Is this key usable, and does this model exist for it?
 *
 * Deliberately a read and not a generation: asking a model to generate something
 * just to see whether the key works makes the answer depend on things that have
 * nothing to do with the key — the output-token floor of that particular model, a
 * quota spent on a real request, a candidate that came back empty because the
 * answer did not fit. All of those read to the user as "your key is wrong" while
 * the key is fine. The model resource itself answers the two questions that
 * matter, for free, and it answers them the same way every time. */
async function testKey(apiKey, model, uiLanguage) {
  if (!apiKey) return { ok: false, errorKey: 'error.noKey', error: t(uiLanguage, 'error.noKey') };
  if (!model) return { ok: false, errorKey: 'error.noModel', error: t(uiLanguage, 'error.noModel') };

  const attempt = async () =>
    callApi(`${API_ROOT}/models/${encodeURIComponent(model)}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey }
    });

  try {
    let res = await attempt();
    /* One retry, only for a blip: a dropped connection or a server that hiccuped
     * is not news about the user's key. */
    if (res.status >= 500) res = await attempt();

    if (!res.ok) {
      const key = errorKeyForStatus(res.status, res.json);
      const vars = statusVars(res.status);
      return { ok: false, errorKey: key, errorVars: vars, error: t(uiLanguage, key, vars) };
    }

    const methods = (res.json && res.json.supportedGenerationMethods) || [];
    if (methods.length && methods.indexOf('generateContent') === -1) {
      return { ok: false, errorKey: 'error.modelUnsupported', error: t(uiLanguage, 'error.modelUnsupported') };
    }
    return { ok: true, model };
  } catch (err) {
    const key = err && err.message === 'timeout' ? 'error.timeout' : 'error.offline';
    return { ok: false, errorKey: key, error: t(uiLanguage, key) };
  }
}

/* The answer is a JSON object — {"speech": bool, "text": string} — because the
 * model has to be able to say "there was nothing to transcribe" and be taken at
 * its word. Asked to answer with the transcript alone, it fills the silence:
 * measured on this machine, a recording of a quiet room came back as an invented
 * sentence, and another as an apology for not being able to transcribe. A schema
 * gives it a legitimate empty answer, which is the one it takes.
 *
 * Prose is still accepted: a model that ignores the shape is transcribed as
 * before rather than thrown away. */
function readTranscript(raw) {
  const text = String(raw || '').trim();
  if (!text) return { speech: null, text: '' };

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { speech: null, text };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return { speech: null, text };
    const transcript = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    const speech = typeof parsed.speech === 'boolean' ? parsed.speech : null;
    /* A model that says there was speech but writes nothing has said the same
     * thing; one that says there was none is believed. */
    if (speech === false) return { speech: false, text: '' };
    if (!transcript && speech === null) return { speech: null, text };
    return { speech: speech === null ? true : speech, text: transcript };
  } catch (_) {
    return { speech: null, text };
  }
}

function readCandidate(json, uiLanguage) {
  const feedback = json && json.promptFeedback;
  const candidate = json && json.candidates && json.candidates[0];
  if (!candidate) {
    if (feedback && feedback.blockReason) {
      return { ok: false, errorKey: 'error.blocked', error: t(uiLanguage, 'error.blocked') };
    }
    return { ok: false, errorKey: 'error.emptyReply', error: t(uiLanguage, 'error.emptyReply') };
  }

  const raw = ((candidate.content && candidate.content.parts) || []).map((p) => p.text || '').join('');
  const answer = readTranscript(raw);
  if (answer.speech === false || !answer.text) {
    if (candidate.finishReason === 'SAFETY') {
      return { ok: false, errorKey: 'error.filtered', error: t(uiLanguage, 'error.filtered') };
    }
    return { ok: false, errorKey: 'error.noSpeech', error: t(uiLanguage, 'error.noSpeech') };
  }
  return { ok: true, text: answer.text, truncated: candidate.finishReason === 'MAX_TOKENS' };
}

/* 8 tokens per second of audio is generous for speech and stops a rambling
 * answer early, which is the cheapest latency win there is. */
function outputCap(seconds) {
  return Math.min(8192, Math.ceil(Math.max(1, seconds) * 8) + 96);
}

/* Exponential backoff with jitter, capped: without jitter every client hit by the
 * same outage retries in lockstep and recreates it. */
function backoffMs(attempt) {
  const base = Math.min(8000, 400 * Math.pow(2, attempt - 1));
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

const RETRYABLE_STATUS = (status) => status === 429 || status >= 500;

async function transcribe({ apiKey, model, wav, settings, seconds, onAttempt }) {
  const uiLanguage = settings.uiLanguage;
  if (!apiKey) return { ok: false, errorKey: 'error.noKey', error: t(uiLanguage, 'error.noKey') };
  if (!model) return { ok: false, errorKey: 'error.noModel', error: t(uiLanguage, 'error.noModel') };

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction(settings) }] },
    contents: [
      {
        role: 'user',
        parts: [
          { text: buildInstruction(settings) },
          { inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } }
        ]
      }
    ],
    // A transcript must not silently drop speech, so keep the filters loose.
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT'
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    generationConfig: { temperature: 0, maxOutputTokens: outputCap(seconds || 0), responseMimeType: 'application/json' }
  };

  /* Extended thinking buys nothing for transcription and costs seconds, so it is
   * switched off on the models that allow it. */
  const thinking = isFlashModel(model);
  if (thinking) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const url = `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`;
  const attempts = Math.max(1, Math.min(5, Number(settings.attempts) || 3));
  const startedAt = Date.now();
  let lastKey = 'error.offline';
  let lastVars = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      if (onAttempt) onAttempt(attempt, attempts);
      await new Promise((r) => setTimeout(r, backoffMs(attempt - 1)));
    }

    const options = {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    };

    let res;
    try {
      res = await callApi(url, options);
    } catch (err) {
      lastKey = err && err.message === 'timeout' ? 'error.timeout' : 'error.offline';
      lastVars = null;
      if (attempt < attempts) continue;
      break;
    }

    /* A 400 is the model refusing part of the request, and the two things it
     * refuses are the thinking config and the JSON answer shape. The thinking goes
     * first — it is the one that costs seconds — and the shape after it, since a
     * model that will not answer in JSON still transcribes and prose is read as
     * prose. A 400 that names the key is none of our business: that is an answer,
     * not something to try again. */
    const refusal = (res.json && res.json.error && res.json.error.message) || '';
    const aboutTheKey = /api[\s_-]?key/i.test(refusal);
    const drop = body.generationConfig.thinkingConfig
      ? 'thinkingConfig'
      : body.generationConfig.responseMimeType
        ? 'responseMimeType'
        : null;
    if (!res.ok && res.status === 400 && drop && !aboutTheKey) {
      delete body.generationConfig[drop];
      options.body = JSON.stringify(body);
      if (process.env.GUYA_DEBUG) console.log(`[guya] the model refused the ${drop}, asking again without it`);
      try {
        res = await callApi(url, options);
      } catch (err) {
        lastKey = 'error.offline';
        if (attempt < attempts) continue;
        break;
      }
    }

    if (res.ok) {
      const parsed = readCandidate(res.json, uiLanguage);
      if (parsed.ok && process.env.GUYA_DEBUG) {
        console.log(`[guya] transcribe: ${Date.now() - startedAt}ms, attempt ${attempt}/${attempts}, ${seconds || 0}s of audio`);
      }
      return parsed;
    }

    lastKey = errorKeyForStatus(res.status, res.json);
    lastVars = statusVars(res.status);
    // Only failures another attempt could fix are retried: a rejected key or a
    // malformed request will be rejected again.
    if (!RETRYABLE_STATUS(res.status) || attempt === attempts) break;

    if (process.env.GUYA_DEBUG) {
      console.log(`[guya] attempt ${attempt}/${attempts} failed with ${res.status}, trying again`);
    }
  }

  return { ok: false, errorKey: lastKey, errorVars: lastVars, error: t(uiLanguage, lastKey, lastVars) };
}


module.exports = { listModels, transcribe, testKey, buildInstruction, systemInstruction, outputCap, warm };

/*
 * Thin Gemini REST client. Two calls are needed:
 *   - listModels(): so the panel can offer the models this key can actually use
 *   - transcribe(): audio -> text via generateContent with inline audio
 * Errors come back as i18n keys, localized by the caller.
 */
'use strict';

const { t } = require('../shared/i18n');
const { languageLine } = require('../shared/prompt');
const { normalizeWavPeak } = require('../shared/audio');

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const ATTEMPT_MIN_MS = 15000;
const ATTEMPT_MAX_MS = 60000;
/* The whole transcription, all attempts and waits included, never takes longer than this. */
const TOTAL_BUDGET_MS = 90000;
/* A server asking for more than this is not asking for a retry. */
const MAX_RETRY_WAIT_MS = 20000;

function fetchImpl() {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch.bind(net);
  } catch (_) {
    /* not running inside electron */
  }
  return globalThis.fetch;
}

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}
const isTimeout = (err) => !!err && (err.name === 'TimeoutError' || err.message === 'timeout');
const isCancelled = (err) => !!err && err.name === 'CancelledError';

/* `config` is either a timeout in ms (the old signature) or { timeoutMs, signal }. */
async function callApi(url, options, config) {
  const cfg = typeof config === 'number' ? { timeoutMs: config } : config || {};
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, cfg.timeoutMs || ATTEMPT_MAX_MS);
  const onOuterAbort = () => controller.abort();
  if (cfg.signal) {
    if (cfg.signal.aborted) controller.abort();
    else cfg.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const res = await fetchImpl()(url, Object.assign({}, options, { signal: controller.signal }));
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text, headers: res.headers };
  } catch (err) {
    if (timedOut) throw namedError('TimeoutError', 'timeout');
    if (cfg.signal && cfg.signal.aborted) throw namedError('CancelledError', 'cancelled');
    throw err;
  } finally {
    clearTimeout(timer);
    if (cfg.signal) cfg.signal.removeEventListener('abort', onOuterAbort);
  }
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
  /* The spoken language of this recording goes in the user turn, which needs a text
   * part beside the audio anyway; saying it twice made the same sentence appear in both
   * places of the request. */
  return (settings.prompt || '').trim();
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

/* Models that exist but cannot take an audio clip, or cannot answer with text. */
const NOT_FOR_TRANSCRIPTION = /(tts|image|imagen|veo|embedding|aqa|gemma|live|native-audio|robotics|computer-use|learnlm|lyria)/i;

async function listModels(apiKey, uiLanguage) {
  if (!apiKey) return { ok: false, errorKey: 'error.noKey' };
  try {
    const found = [];
    let pageToken = '';
    /* A key with many models answers in pages; the first page is not the list. */
    do {
      const url = `${API_ROOT}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      let res = await callApi(url, { method: 'GET', headers: { 'x-goog-api-key': apiKey } });
      /* A blip is not a verdict on the key: try once more before saying anything. */
      if (!pageToken && res.status >= 500) {
        res = await callApi(url, { method: 'GET', headers: { 'x-goog-api-key': apiKey } });
      }
      if (!res.ok) {
        const key = errorKeyForStatus(res.status, res.json);
        return { ok: false, errorKey: key, errorVars: statusVars(res.status), error: t(uiLanguage, key, statusVars(res.status)) };
      }
      ((res.json && res.json.models) || []).forEach((m) => found.push(m));
      pageToken = (res.json && res.json.nextPageToken) || '';
    } while (pageToken);

    const models = found
      .filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1)
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        label: m.displayName || String(m.name || '').replace(/^models\//, '')
      }))
      .filter((m) => m.id && !NOT_FOR_TRANSCRIPTION.test(m.id));
    models.sort((a, b) => {
      const rank = (m) => (/flash-lite/.test(m.id) ? 1 : /flash/.test(m.id) ? 0 : /pro/.test(m.id) ? 2 : 3);
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    });
    return { ok: true, models };
  } catch (err) {
    const key = isTimeout(err) ? 'error.timeout' : 'error.offline';
    return { ok: false, errorKey: key, error: t(uiLanguage, key) };
  }
}

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

/* The answer is a JSON object — {"speech": bool, "text": string} — see DESIGN.md for why.
 * Prose is still accepted. What is never accepted is half of a JSON object: an answer cut
 * off by the token limit is salvaged (its text field) or rejected, never pasted raw. */
const ANSWER_SHAPE = /^\s*\{\s*"(speech|text)"/;

function stripFences(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
}

function readTranscript(raw) {
  const text = stripFences(String(raw || '').trim());
  if (!text) return { speech: null, text: '' };

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        const transcript = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        const speech = typeof parsed.speech === 'boolean' ? parsed.speech : null;
        if (speech === false) return { speech: false, text: '' };
        if (!transcript && speech === null) return { speech: null, text };
        return { speech: speech === null ? true : speech, text: transcript };
      }
    } catch (_) {
      /* fall through to the salvage below */
    }
  }

  if (ANSWER_SHAPE.test(text)) {
    if (/"speech"\s*:\s*false/.test(text)) return { speech: false, text: '' };
    const field = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text.replace(/\\$/, ''));
    if (!field) return { speech: null, text: '', unreadable: true };
    let value = field[1];
    try {
      value = JSON.parse('"' + value + '"');
    } catch (_) {
      /* keep the raw capture: it is still the speaker's words */
    }
    return { speech: true, text: String(value).trim(), partial: true };
  }
  return { speech: null, text };
}

function readCandidate(json, uiLanguage) {
  const feedback = json && json.promptFeedback;
  const candidate = json && json.candidates && json.candidates[0];
  if (!candidate) {
    if (feedback && feedback.blockReason) {
      return { ok: false, errorKey: 'error.blocked', error: t(uiLanguage, 'error.blocked') };
    }
    /* No answer at all is not a verdict about the audio: ask again. */
    return { ok: false, errorKey: 'error.emptyReply', error: t(uiLanguage, 'error.emptyReply'), retryable: true };
  }

  const raw = ((candidate.content && candidate.content.parts) || []).map((p) => (p.thought ? '' : p.text || '')).join('');
  const answer = readTranscript(raw);
  const capped = candidate.finishReason === 'MAX_TOKENS';
  /* An empty response with a normal ending is the provider having nothing to say, not
   * the model deciding there was no speech — only {"speech":false} is that. */
  if (!raw.trim() && !capped && candidate.finishReason !== 'SAFETY') {
    return { ok: false, errorKey: 'error.emptyReply', error: t(uiLanguage, 'error.emptyReply'), retryable: true };
  }
  if (answer.unreadable || (!raw.trim() && capped)) {
    /* Nothing usable and the model ran out of room (thinking tokens count against the cap):
     * that is a reason to ask again with more room, not a verdict about the audio. */
    return { ok: false, errorKey: 'error.emptyReply', error: t(uiLanguage, 'error.emptyReply'), needsMoreTokens: capped };
  }
  if (answer.speech === false || !answer.text) {
    if (candidate.finishReason === 'SAFETY') {
      return { ok: false, errorKey: 'error.filtered', error: t(uiLanguage, 'error.filtered') };
    }
    return { ok: false, errorKey: 'error.noSpeech', error: t(uiLanguage, 'error.noSpeech') };
  }
  return { ok: true, text: answer.text, truncated: capped || !!answer.partial };
}

/* maxOutputTokens is a ceiling, not a target: nothing is billed or waited for beyond what the
 * model writes, so it is generous. Persian and Arabic cost several tokens per word, and models
 * that think spend part of the same budget before the first word. `reserve` is that part. */
function outputCap(seconds, reserve) {
  return Math.min(8192, Math.ceil(Math.max(1, seconds) * 16) + 256 + (reserve || 0));
}

function backoffMs(attempt) {
  const base = Math.min(8000, 400 * Math.pow(2, attempt - 1));
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

/* How long the server itself asked us to wait: Retry-After, or the RetryInfo detail Google
 * attaches to a 429 ("37s"). null when it said nothing. */
function retryDelayMs(res) {
  const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const details = res.json && res.json.error && res.json.error.details;
  if (Array.isArray(details)) {
    for (const item of details) {
      const match = item && typeof item.retryDelay === 'string' ? /^([\d.]+)s$/.exec(item.retryDelay) : null;
      if (match) return Math.ceil(parseFloat(match[1]) * 1000);
    }
  }
  return null;
}

/* A per-day quota will not be back in a few seconds: do not spend attempts on it. */
function isDailyQuota(json) {
  const details = json && json.error && json.error.details;
  return Array.isArray(details) && /PerDay/i.test(JSON.stringify(details));
}

function isRetryable(status, json) {
  if (status === 429) return !isDailyQuota(json);
  return status === 408 || status >= 500;
}

/* Per attempt: short clips fail fast so a retry starts sooner; long clips get room. */
function attemptTimeoutMs(seconds) {
  return Math.min(ATTEMPT_MAX_MS, Math.max(ATTEMPT_MIN_MS, 10000 + Math.ceil(seconds || 0) * 1000));
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), ms);
    const onAbort = () => done(true);
    function done(cancelled) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(cancelled);
    }
    if (signal) {
      if (signal.aborted) return done(true);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/* What each model has refused so far, remembered for the session: a model that rejects
 * the thinking config should cost one failed request once, not one per recording. */
const refusals = new Map();
const FIELD_HINTS = [
  ['thinkingConfig', /think|budget|level/i],
  ['responseSchema', /schema/i],
  ['responseMimeType', /mime|json/i]
];

function thinkingConfigFor(model) {
  const id = String(model || '');
  if (/gemini-3/i.test(id)) return { thinkingLevel: /flash/i.test(id) ? 'minimal' : 'low' };
  if (/pro/i.test(id)) return { thinkingBudget: 128 };
  if (/flash/i.test(id)) return { thinkingBudget: 0 };
  return null;
}

function thinkingReserve(model) {
  return /pro|gemini-3/i.test(String(model || '')) ? 512 : 0;
}

const ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: { speech: { type: 'BOOLEAN' }, text: { type: 'STRING' } },
  required: ['speech', 'text'],
  propertyOrdering: ['speech', 'text']
};

function buildBody({ model, settings, seconds, audio, refused, tokenBoost }) {
  const generationConfig = {
    temperature: 0,
    maxOutputTokens: Math.min(8192, outputCap(seconds || 0, thinkingReserve(model)) * tokenBoost)
  };
  if (!refused.has('responseMimeType')) {
    generationConfig.responseMimeType = 'application/json';
    if (!refused.has('responseSchema')) generationConfig.responseSchema = ANSWER_SCHEMA;
  }
  const thinking = thinkingConfigFor(model);
  if (thinking && !refused.has('thinkingConfig')) generationConfig.thinkingConfig = thinking;

  return {
    systemInstruction: { parts: [{ text: systemInstruction(settings) }] },
    contents: [{ role: 'user', parts: [{ text: buildInstruction(settings) }, { inlineData: { mimeType: 'audio/wav', data: audio } }] }],
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT'
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    generationConfig
  };
}

async function transcribe({ apiKey, model, wav, settings, seconds, measuredSpeechMs, onAttempt, signal }) {
  const uiLanguage = settings.uiLanguage;
  if (!apiKey) return { ok: false, errorKey: 'error.noKey', error: t(uiLanguage, 'error.noKey') };
  if (!model) return { ok: false, errorKey: 'error.noModel', error: t(uiLanguage, 'error.noModel') };

  const cancelled = () => ({ ok: false, cancelled: true, errorKey: 'error.cancelled' });
  const url = `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`;
  const attempts = Math.max(1, Math.min(5, Number(settings.attempts) || 3));
  let audio = Buffer.from(wav).toString('base64'); // once, not once per attempt
  let boosted = false; // the loud retry happens at most once per transcription
  const refused = refusals.get(model) || new Set();
  refusals.set(model, refused);

  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_BUDGET_MS;
  let tokenBoost = 1;
  let lastKey = 'error.offline';
  let lastVars = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal && signal.aborted) return cancelled();
    const remaining = deadline - Date.now();
    if (remaining < 4000) break;

    let res;
    let hadRefusal = true;
    try {
      /* Same attempt, fewer features: a 400 that names a feature this model does not have is
       * answered by asking again without it, as many times as there are such features. */
      while (hadRefusal) {
        hadRefusal = false;
        const body = buildBody({ model, settings, seconds, audio, refused, tokenBoost });
        res = await callApi(
          url,
          { method: 'POST', headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body) },
          { timeoutMs: Math.min(attemptTimeoutMs(seconds), Math.max(3000, deadline - Date.now())), signal }
        );
        const message = (res.json && res.json.error && res.json.error.message) || '';
        if (!res.ok && res.status === 400 && !/api[\s_-]?key/i.test(message)) {
          const hit = FIELD_HINTS.find(([field, hint]) => !refused.has(field) && hint.test(message) && (field !== 'thinkingConfig' || thinkingConfigFor(model)));
          if (hit) {
            refused.add(hit[0]);
            hadRefusal = true;
            if (process.env.GUYA_DEBUG) console.log(`[guya] the model refused ${hit[0]}, asking again without it`);
          }
        }
      }
    } catch (err) {
      if (isCancelled(err)) return cancelled();
      lastKey = isTimeout(err) ? 'error.timeout' : 'error.offline';
      lastVars = null;
      if (attempt >= attempts) break;
      if (onAttempt) onAttempt(attempt + 1, attempts);
      if (await sleep(backoffMs(attempt), signal)) return cancelled();
      continue;
    }

    if (res.ok) {
      const parsed = readCandidate(res.json, uiLanguage);
      if (parsed.ok) {
        if (process.env.GUYA_DEBUG) console.log(`[guya] transcribe: ${Date.now() - startedAt}ms, attempt ${attempt}/${attempts}, ${seconds || 0}s of audio`);
        return parsed;
      }
      if (parsed.needsMoreTokens && attempt < attempts) {
        tokenBoost = Math.min(4, tokenBoost * 2);
        if (onAttempt) onAttempt(attempt + 1, attempts);
        continue;
      }
      /* 5b: the app measured real speech and the model says there was none. Asking the
       * same quiet audio again at temperature 0 changes nothing, so the second attempt
       * is the same recording made louder. */
      if (parsed.errorKey === 'error.noSpeech' && !boosted && measuredSpeechMs >= 1000 && attempt < attempts) {
        const louder = normalizeWavPeak(wav);
        if (louder !== wav) {
          boosted = true;
          audio = Buffer.from(louder).toString('base64');
          if (onAttempt) onAttempt(attempt + 1, attempts);
          continue;
        }
      }
      if (parsed.retryable && attempt < attempts) {
        if (onAttempt) onAttempt(attempt + 1, attempts);
        if (await sleep(backoffMs(attempt), signal)) return cancelled();
        continue;
      }
      return parsed;
    }

    lastKey = errorKeyForStatus(res.status, res.json);
    lastVars = statusVars(res.status);
    if (!isRetryable(res.status, res.json) || attempt >= attempts) break;

    let wait = backoffMs(attempt);
    if (res.status === 429) {
      const asked = retryDelayMs(res);
      if (asked !== null) wait = Math.max(wait, asked + 250);
    }
    /* Waiting longer than the user would sit through is not a retry, it is a hang. */
    if (wait > MAX_RETRY_WAIT_MS || Date.now() + wait + 4000 > deadline) {
      if (res.status === 429) lastVars = { status: res.status, retryAfter: Math.ceil(wait / 1000) };
      break;
    }
    if (onAttempt) onAttempt(attempt + 1, attempts);
    if (await sleep(wait, signal)) return cancelled();
  }

  const finalKey = lastKey === 'error.quota' && lastVars && lastVars.retryAfter ? 'error.quotaWait' : lastKey;
  return { ok: false, errorKey: finalKey, errorVars: lastVars, error: t(uiLanguage, finalKey, lastVars) };
}

module.exports = { listModels, transcribe, testKey, buildInstruction, systemInstruction, outputCap, warm, readTranscript, retryDelayMs, isRetryable };

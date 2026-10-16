#!/usr/bin/env node
/*
 * Structure gate: the things a test can see about the shape of the code.
 *
 *   1. no require cycle between main-process modules,
 *   2. every destructured require names something the module actually exports,
 *   3. src/shared/ stays process-agnostic (no Electron, no DOM assumptions),
 *   4. no module calls a name it never defines.
 *
 *   node scripts/check-structure.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main');
const problems = [];

function filesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
}

/* ---- 2. exports match imports ---- */
const exported = {};
for (const file of filesIn(MAIN)) {
  const source = fs.readFileSync(path.join(MAIN, file), 'utf8');
  const literal = /module\.exports = \{([^}]*)\}/.exec(source);
  const single = /module\.exports = (\w+)/.exec(source);
  exported[file] = literal
    ? literal[1].split(',').map((entry) => entry.trim().split(':')[0].trim()).filter(Boolean)
    : single
      ? [single[1]]
      : [];
}

for (const file of filesIn(MAIN)) {
  const source = fs.readFileSync(path.join(MAIN, file), 'utf8');
  const pattern = /const \{ ([^}]+) \} = require\('\.\/(\w+)'\)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const names = match[1].split(',').map((name) => name.trim().split(':')[0].trim()).filter(Boolean);
    const target = `${match[2]}.js`;
    for (const name of names) {
      if (!exported[target] || exported[target].indexOf(name) === -1) {
        problems.push(`${file} imports { ${name} } which ${target} does not export`);
      }
    }
  }
}

/* ---- 1. no cycles ---- */
const graph = {};
for (const file of filesIn(MAIN)) {
  const source = fs.readFileSync(path.join(MAIN, file), 'utf8');
  graph[file] = Array.from(source.matchAll(/require\('\.\/(\w+)'\)/g)).map((m) => `${m[1]}.js`);
}

function walk(node, trail, seen) {
  for (const next of graph[node] || []) {
    if (trail.indexOf(next) !== -1) {
      const cycle = trail.slice(trail.indexOf(next)).concat(next).join(' -> ');
      if (seen.indexOf(cycle) === -1) {
        seen.push(cycle);
        problems.push(`cycle: ${cycle}`);
      }
      continue;
    }
    walk(next, trail.concat(next), seen);
  }
}

const cycles = [];
Object.keys(graph).forEach((file) => walk(file, [file], cycles));

/* ---- 3. shared stays portable ---- */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

fs.readdirSync(path.join(ROOT, 'src', 'shared')).forEach((name) => {
  if (!name.endsWith('.js')) return;
  const source = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'shared', name), 'utf8'));
  if (/require\('electron'\)/.test(source)) problems.push(`src/shared/${name} requires electron`);
  if (/\bdocument\.|\bwindow\./.test(source)) problems.push(`src/shared/${name} touches the DOM`);
});

/* ---- 4. no call to a name the module never defines ---- */

/* A call to an undefined name is not a syntax error, so nothing before this point
 * sees it: it throws at the moment that line runs, which in a packaged app is an
 * "Uncaught Exception" in front of the user. That has happened twice — a recording
 * that could not start, and a global shortcut that could not start one either —
 * so the whole source tree is read for it. This is a reading of the text, not a
 * compiler: comments, strings and regular expressions are removed first, and the
 * names a file may legitimately call are its own declarations, its parameters, and
 * the globals below. */
const GLOBALS = new Set(
  (
    'require module exports process console globalThis self window document Buffer ' +
    'Intl Math JSON Object Array String Number Boolean Date Promise Error TypeError RangeError ' +
    'SyntaxError Map Set WeakMap WeakSet RegExp Symbol Proxy Reflect ' +
    'AbortController AbortSignal URL URLSearchParams Response Request Headers fetch ' +
    'TextEncoder TextDecoder Int8Array Int16Array Int32Array Uint8Array Uint16Array Uint32Array ' +
    'Float32Array ArrayBuffer DataView SharedArrayBuffer ' +
    'setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone ' +
    'atob btoa performance isNaN parseInt parseFloat encodeURIComponent decodeURIComponent'
  ).split(' ')
);
const KEYWORDS = new Set(
  ('if for while switch catch return typeof new function else do await yield in of async ' +
    'delete void instanceof').split(' ')
);

function stripLiterals(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    /* Regular expressions before templates: a backtick inside a character class is
     * not the start of a template literal, and reading it as one swallows the rest of
     * the file. Strings are safe to do after, because a quote is not one of the
     * characters a regular expression can follow (see the lookbehind below). */
    .replace(/([=(,:;[!&|?{}]\s*|\breturn\s+)\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, '$1//')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/* `{ a, b: c }` and `{ a = 1 }` both bind the names on the left. */
function boundNames(list) {
  return list
    .split(',')
    .map((part) => part.replace(/[[\]{}()]/g, '').split(/[,:=]/).pop().trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

function declaredNames(code) {
  const names = new Set();
  const patterns = [
    [/\bfunction\s+([A-Za-z_$][\w$]*)/g, false],
    [/\bclass\s+([A-Za-z_$][\w$]*)/g, false],
    [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, false],
    [/\b(?:const|let|var)\s+(\{[^}]*\})\s*=/g, true],
    [/\bfunction\s*[^(]*\(([^)]*)\)/g, true],
    [/\(([^)]*)\)\s*=>/g, true],
    [/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g, false],
    [/\bcatch\s*\(([^)]*)\)/g, true]
  ];
  patterns.forEach((pair) => {
    const pattern = pair[0];
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code))) {
      (pair[1] ? boundNames(match[1]) : [match[1]]).forEach((name) => names.add(name));
    }
  });
  return names;
}

function undefinedCalls(source) {
  const code = stripLiterals(source);
  const known = declaredNames(code);
  const calls = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  const unknown = new Set();
  let match;
  while ((match = calls.exec(code))) {
    if (known.has(match[1]) || GLOBALS.has(match[1]) || KEYWORDS.has(match[1])) continue;
    unknown.add(match[1]);
  }
  return Array.from(unknown);
}

/* Only the process-agnostic files are read this way. The renderers share one global
 * scope across scripts and run in two realms — a page and an AudioWorklet — so
 * "this file never defines it" is not a question with an answer there; the
 * end-to-end run is what catches a broken renderer, and it fails on any error the
 * page reports. */
['src/main', 'src/shared', 'src/preload'].forEach((dir) => {
  fs.readdirSync(path.join(ROOT, dir)).forEach((name) => {
    if (!name.endsWith('.js')) return;
    const unknown = undefinedCalls(fs.readFileSync(path.join(ROOT, dir, name), 'utf8'));
    if (unknown.length) problems.push(`${dir}/${name} calls ${unknown.join(', ')}, which it never defines`);
  });
});

if (problems.length) {
  console.error(problems.map((line) => `  ✗ ${line}`).join('\n'));
  process.exit(1);
}
console.log(`  ✓ structure: ${filesIn(MAIN).length} main modules, no cycles, no undefined calls, imports match exports`);

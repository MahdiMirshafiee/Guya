#!/usr/bin/env node
/*
 * Structure gate: the things a test can see about the shape of the code.
 *
 *   1. no require cycle between main-process modules,
 *   2. every destructured require names something the module actually exports,
 *   3. src/shared/ stays process-agnostic (no Electron, no DOM assumptions).
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

if (problems.length) {
  console.error(problems.map((line) => `  ✗ ${line}`).join('\n'));
  process.exit(1);
}
console.log(`  ✓ structure: ${filesIn(MAIN).length} main modules, no cycles, imports match exports`);

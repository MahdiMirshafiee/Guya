#!/usr/bin/env node
/*
 * Package for the machine you are on.
 *
 * Linux artifacts are built on Linux (a deb needs dpkg, an AppImage needs
 * appimagetool), Windows artifacts on Windows, macOS artifacts on macOS — so this
 * picks the target from the platform instead of making you remember which one.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const targets = { darwin: '--mac', win32: '--win', linux: '--linux' };
const target = targets[process.platform];

if (!target) {
  console.error(`no packaging target for ${process.platform}`);
  process.exit(1);
}

const icons = spawnSync('npm', ['run', 'icons'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (icons.status !== 0) process.exit(icons.status || 1);

const builder = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const build = spawnSync(builder, [target], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(build.status || 0);

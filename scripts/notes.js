#!/usr/bin/env node
/*
 * Release notes for a tag, written from the commits since the previous one.
 *
 * GitHub's own generated notes are a list of merge commits and a link, which tells a
 * reader nothing about what changed in the app. This groups the commits by what they
 * are — features, fixes, performance — keeps the scope the commit already declares,
 * drops the bookkeeping, and ends with the table a user actually needs: which file to
 * download for their machine.
 *
 *   node scripts/notes.js                  # since the previous tag, up to HEAD
 *   node scripts/notes.js v1.1.0 v1.0.0    # the tag, then what it is compared against
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function tags() {
  try {
    return git(['tag', '--sort=-v:refname']).split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

/* `subject` on the first line, the body after it — the body is where the reason is,
 * and the reason is the part worth putting in front of a reader. */
function commitsIn(range) {
  const raw = git(['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range]);
  return raw
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, subject, body] = entry.split('\x1f');
      const parsed = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject || '');
      return {
        hash: (hash || '').trim().slice(0, 7),
        type: parsed ? parsed[1] : 'other',
        scope: parsed ? parsed[2] || '' : '',
        breaking: !!(parsed && parsed[3]),
        title: parsed ? parsed[4].trim() : (subject || '').trim(),
        body: (body || '').replace(/\n+/g, ' ').trim()
      };
    });
}

/* What a reader cares about, in the order they care about it. Everything else is
 * bookkeeping: release commits, and the work that only touches the repository. */
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Under the hood']
];
const HIDDEN = ['chore', 'docs', 'test', 'ci', 'style', 'build', 'other'];

function render(commits, options) {
  const lines = [];
  /* A first release has nothing to compare against: the summary above it describes the
   * app, and a list of every commit that built it would only bury that. */
  const listed = options.firstRelease ? [] : commits;
  for (const [type, heading] of SECTIONS) {
    const matching = listed.filter((commit) => commit.type === type);
    if (!matching.length) continue;
    lines.push(`### ${heading}`, '');
    for (const commit of matching) {
      /* One line each: the scope the commit declared, then what changed. The reason
       * behind it is in the commit itself, where someone looking for it will be. */
      const scope = commit.scope ? `**${commit.scope}** — ` : '';
      lines.push(`- ${scope}${commit.title}${commit.breaking ? ' **(breaking)**' : ''}`);
    }
    lines.push('');
  }

  const hidden = commits.filter((commit) => HIDDEN.indexOf(commit.type) !== -1);
  if (!lines.length && !options.firstRelease) lines.push('Maintenance and documentation only.', '');

  lines.push('### Downloads', '');
  lines.push('| Your system | File |', '| --- | --- |');
  const v = options.version;
  lines.push(
    `| macOS, Apple silicon | \`Guya-${v}-macOS-arm64.dmg\` |`,
    `| macOS, Intel | \`Guya-${v}-macOS-x64.dmg\` |`,
    `| Windows, x64 | \`Guya-${v}-Windows-x64-Setup.exe\` |`,
    `| Windows, arm64 | \`Guya-${v}-Windows-arm64-Setup.exe\` |`,
    `| Windows, without installing | \`Guya-${v}-Windows-x64-Portable.exe\` or \`Guya-${v}-Windows-arm64-Portable.exe\` |`,
    `| Linux, x64 | \`Guya-${v}-Linux-x86_64.AppImage\` or \`Guya-${v}-Linux-amd64.deb\` |`,
    `| Linux, arm64 | \`Guya-${v}-Linux-arm64.AppImage\` or \`Guya-${v}-Linux-arm64.deb\` |`,
    ''
  );
  /* Every system ships both of its architectures, and the name says which is which: a
   * download that turns out to be for the machine next door is the failure this table
   * exists to prevent. */
  lines.push(
    'Each system ships both of its architectures, and the file name says which is which —',
    '`arm64` for Apple silicon and ARM machines, `x64` (or Linux\'s own `x86_64` and',
    '`amd64`) for Intel and AMD. On Windows an ARM machine can run the x64 build too.',
    ''
  );
  lines.push('The builds are unsigned. On macOS 15 and later there is no *Open* in the');
  lines.push('Control-click menu for an app like this: `xattr -dr com.apple.quarantine');
  lines.push('/Applications/Guya.app` once, or System Settings → Privacy & Security →');
  lines.push('*Open Anyway*. Windows shows SmartScreen\'s "More info → Run anyway".', '');

  if (options.previous) {
    lines.push(`**Full comparison:** [\`${options.previous}…${options.tag}\`](${options.compareUrl})`, '');
  }
  if (options.firstRelease) {
    lines.push(`<sub>${commits.length} commits went into this release; the history is in the repository, one section at a time.</sub>`, '');
  } else if (hidden.length) {
    lines.push(`<sub>${hidden.length} commit${hidden.length === 1 ? '' : 's'} of documentation, tests and release bookkeeping are not listed.</sub>`, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* The first release is not a list of changes — there is nothing to compare it to.
 * It is a description of what the app is, so the notes of v1.0.0 read like an
 * introduction rather than 76 commit subjects. */
const FIRST_RELEASE = [
  '**Voice to text on your desktop, with your own Gemini key.** One shortcut records,',
  'the audio goes straight to Google with your key, and the transcript lands on your',
  'clipboard — typed into whatever app has focus, if you ask for it. macOS, Windows and',
  'Linux, arm64 and x64.',
  '',
  '- **A real equalizer.** The window\'s meter and the floating orb are drawn from the',
  '  microphone: forty-eight bands measured in decibels against the noise floor of the',
  '  room you are in, so a fan reads as nothing and your voice moves it.',
  '- **It stops on its own**, three seconds after your last word — and a recording nobody',
  '  spoke into is refused without a request being sent at all.',
  '- **A speaker who mixes languages gets each part back in its own.** Persian with an',
  '  English term in the middle stays that way, in both scripts and in one sentence.',
  '- **No standing microphone.** No wake word, no always-on listening: the device opens',
  '  when a recording starts and closes when it stops.',
  '- **Nothing in the middle.** No account, no server of the app\'s own, no telemetry;',
  '  the key is kept encrypted by the system — the keychain on macOS, DPAPI on Windows.',
  '',
  'The settings screen takes the key (with a link to where you get one), the model, the',
  'two waits, the shortcut and the instructions sent to the model. Nothing else is asked.'
];

/* Version order, not the order tags were made in: a tag can be cut after a later one
 * exists (a first release prepared once an early tag was dropped), and the previous
 * release is the highest tag below this version, whichever order they were created. */
function compareVersions(a, b) {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const all = tags();
  const tag = args[0] || '';
  const version = (tag || require(path.join(ROOT, 'package.json')).version).replace(/^v/, '');
  /* The tag being released may not exist locally (it is cut from CI, or the range is
   * being previewed), in which case the notes are for HEAD. */
  const target = tag && all.indexOf(tag) !== -1 ? tag : 'HEAD';
  const previous = args[1] || all
    .filter((name) => name !== tag && compareVersions(name, version) < 0)
    .sort((a, b) => compareVersions(b, a))[0] || '';
  const range = previous ? `${previous}..${target}` : target;
  const remote = (() => {
    try {
      const url = git(['remote', 'get-url', 'origin']);
      return url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
    } catch (_) {
      return '';
    }
  })();

  const notes = render(commitsIn(range), {
    tag: tag || 'unreleased',
    version,
    previous,
    firstRelease: !previous,
    compareUrl: remote && previous ? `${remote}/compare/${previous}...${tag}` : ''
  });
  process.stdout.write(previous ? notes : `${FIRST_RELEASE.join('\n')}\n\n${notes}`);
}

if (require.main === module) main();

module.exports = { commitsIn, render };

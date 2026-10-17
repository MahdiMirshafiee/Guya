# AGENTS.md

Working agreement for anyone — human or agent — changing this repository.
Read it before the first edit, follow it without being asked, and keep it true.

---

## What this is

**Guya** (گویا) is a minimal voice-to-text utility for macOS, Windows and Linux. One
shortcut records, the audio goes to the Gemini API with the user's own key, and
the transcript lands on the clipboard (and optionally gets typed into the focused
app). An orb floats above the desktop so the microphone is never live invisibly.

- `DESIGN.md` is the source of truth for the interface. **If you change how
  something looks or behaves, change that document in the same change.**
- `README.md` is the user-facing guide and the primary one, in English; `README.fa.md`
  is the same guide in Persian. Both are maintained together — a change to how the app
  behaves belongs in both, or the repository starts telling two stories.
- `src/main/` is the main process, split by responsibility: `index.js` starts and
  wires, `recorder.js` owns a recording session, `state.js` owns the phase,
  `ipc.js` is the whole contract with the renderers, `system.js` is everything the
  OS is asked for, `platform.js` is what differs per system. No cycles: leaves
  first, composition last.
- `src/renderer/panel/` is the window (recorder + settings), `src/renderer/overlay/`
  is the floating indicator and its capture worklet, `src/renderer/assets/` is what
  both load (the orb renderer and the fonts).
- `src/shared/` is plain JavaScript used by both processes; it must not import
  Electron. `i18n.js` is the two-language dictionary, `prompt.js` the English
  instructions sent to the model.

## Non-negotiables

These are checked by tests, or should be. Breaking one is a bug, not a style
preference.

1. **No hardcoded user-visible string.** Every word comes from
   `src/shared/i18n.js`, in both languages. The test suite fails on non-Latin
   script or a hardcoded `aria-label`/`placeholder` anywhere outside that file.
   The dictionary is for what the user reads. What the *model* reads — the
   transcription instructions in `src/shared/prompt.js` — is not interface copy:
   one precise English text, never translated, because a job description has one
   reader, nobody in the window ever sees it, and a second copy in another
   language is a second thing to keep in step.
2. **Messages cross the process boundary as keys, never as sentences.** A
   renderer that is switched to the other language later must be able to say the
   same thing in that language. Translate at the moment you draw.
3. **A transcript carries its own direction.** Direction is decided per paragraph
   by counting strong characters (`src/shared/bidi.js`) — never by the interface
   language, and never by `dir="auto"`, which only looks at the first character.
4. **The microphone is open only while recording.** No always-on listening, no
   wake word. The setting that types into other apps stays off until macOS has
   actually granted Accessibility — the app refuses it, and offers the pane.
5. **The design tokens are closed.** Spacing from `{4, 8, 12, 16, 20, 24}`, four
   type roles, two radii, one motion duration. The accent is the system accent.
   Glass is for controls, never for content. One prominent control per screen.
6. **No spinner, no decorative motion.** While recording, every movement comes
   from the microphone; the orb's flow carries "working".
7. **`GUYA_SKIP_MIC_PREFLIGHT=1` exists only for the end-to-end harness.** Never
   ship a path that skips a permission check for real users.
8. **No development leftovers.** No debug prints outside `GUYA_DEBUG`, no dead
   tokens or rules, no commented-out code, no test patches left in `src/`.

## Commands

| What | Command |
| --- | --- |
| Run the app | `npm start` |
| Unit tests | `npm test` |
| Lint the module graph | `node scripts/check-structure.js` |
| End-to-end (launches the app with a fake microphone) | `npm run e2e` |
| Regenerate the icon | `npm run icons` |
| Package for this machine | `npm run dist:this` |
| Package for a named platform | `npm run dist:mac` / `dist:win` / `dist:linux` / `dist` |
| Build, install and register on this machine | `npm run install:mac` |
| Cut a release | `scripts/release.sh 1.1.0` |
| Preview the release notes | `npm run notes v1.1.0` |
| Publish or re-cut it by hand | `scripts/publish-release.sh v1.0.0 notes.md <files…>` |

## Definition of done

Before calling a change finished:

1. `npm test` passes, and `node scripts/check-structure.js` reports no cycles,
   no destructured import that names something a module does not export, no call
   to a name a module never defines, and no module importing Electron from
   `src/shared/`.
2. `npm run e2e` passes when anything the user sees changed. It is the only check
   that reads what is actually on screen.
3. If the interface changed: look at it. Start with
   `GUYA_DEBUG=1 npm start`, and screenshot the recorder and the settings screen
   in **both** languages and **both** appearances. A layout that is only tested in
   one direction is half-tested.
4. If behaviour changed: `DESIGN.md` says so, including the decision and the
   alternative you rejected.
5. If the interface changed on this machine: run `scripts/install.sh` and say so.
   It builds, replaces `/Applications/Guya.app`, tells Launch Services about the
   new copy and removes the build output. Copying a bundle by hand is not enough:
   Launch Services remembers paths, and an app opened once from `dist/` leaves an
   entry behind that hides the installed copy from Launchpad.
   The installed app is what the user actually runs.

## Commits

Conventional commits, and **one section per commit** — never one commit for a
whole session's work. Order them so the history reads as the product was built:
scaffold, then audio, then the provider, then the shell, then the interface, then
tests and docs, then CI.

```
feat(audio): microphone capture, resampling and WAV encoding
fix(panel): keep the transcript copy reading the state, not the DOM
docs(design): record why the wake word was removed
ci: build and publish releases from a tag
```

Before committing: `git status` should show only what the commit is about. Do not
commit `node_modules/`, `dist/`, logs or machine-specific files. The commit
message says *why* in the body when the reason is not obvious from the subject.

Work on `main` in this repository. Do not rewrite pushed history.

## Releases

```
scripts/release.sh 1.1.0
```

It checks the tree is clean, runs the tests, regenerates the icon, bumps
`package.json` and the lock file, commits `chore(release): v1.1.0`, tags
`v1.1.0` and pushes both. The tag starts `.github/workflows/release.yml`, which:

1. verifies the tag equals the version in `package.json` (and runs the tests),
2. builds on `macos-latest`, `windows-latest` and `ubuntu-latest` with
   `electron-builder` — each platform packages on its own system, because a deb
   needs dpkg and an AppImage needs appimagetool,
3. publishes it with `scripts/publish-release.sh`, which creates the release and
   attaches the `.dmg`, `.exe`, `.AppImage` and `.deb`. Each system is built for
   both of its architectures, and every file name carries the architecture it is
   for, so nothing on the page needs a note explaining which download to pick.

A version that shipped with something wrong with it is published again under the
same tag: push the tag again and `scripts/publish-release.sh` re-cuts the release —
the notes are rewritten from the commits as they are now, the new files replace the
old ones, and a file the build no longer produces is removed, so the page never
offers two downloads for one job. The script is the whole publish path and can be
run by hand with `gh` on the PATH:

```bash
GITHUB_REPOSITORY=owner/Guya scripts/publish-release.sh v1.0.0 notes.md dist/*.dmg dist/*.exe dist/*.AppImage dist/*.deb
```

`npm run notes v1.0.0 > notes.md` writes the notes the workflow writes, and the script
wants `GITHUB_REPOSITORY` because it also runs outside a checkout.

`.github/workflows/ci.yml` runs the unit tests on all three systems, the
end-to-end suite on macOS, and packages all three platforms on every push.

The artifacts are unsigned unless `CSC_LINK`/`CSC_KEY_PASSWORD` (macOS) and the
Windows equivalent are set as repository secrets; without them macOS shows the
usual Gatekeeper warning on another machine.

## First-time setup on a new machine

```bash
npm ci                 # exact dependency tree, as CI uses
npm start              # run it
npm test && npm run e2e
```

To put this repository on GitHub (it has no remote until you add one):

```bash
gh repo create guya --private --source=. --remote=origin --push
# or: git remote add origin git@github.com:<you>/guya.git && git push -u origin main
```

## Things this project deliberately does not have

No history, no accounts, no sync, no telemetry, no auto-update, no analytics, no
tray icon, no wake word, no theme or accent picker, no second microphone owner.
Adding one of these is a product decision, not an implementation detail — raise it
before writing code.

# Guya — Design Specification

A local-first voice-to-text utility for macOS and Windows.

Target: macOS 26 (Tahoe) · Windows 11 · Linux (x64 and arm64) · Electron 44 · Chromium 140
Design language: Apple Human Interface Guidelines + Liquid Glass, carried to the other
two platforms unchanged — the material differs (vibrancy, acrylic, or a plain window),
the interface does not.

---

## 1. Purpose

Guya has exactly two jobs.

1. Press one thing, speak, and get trustworthy text — with your own Gemini key, going straight from the machine to the provider.
2. Have that text waiting on the clipboard (and, if you ask for it, typed into the app you are already in).

Everything else is out of scope. There is no history, no library, no account, no sync, no onboarding, no telemetry, no auto-update, no theme picker, no accent picker, no tray icon. The product is one shortcut, one orb, one panel.

This document specifies how it looks and behaves, and — just as importantly — what it deliberately does not contain.

---

## 2. Design principles

These are not aspirations; they are acceptance criteria.

**P1 — One hero, one action.**
Each surface has exactly one focal point. The panel's focal point is the record button; every other control is quieter than it. The orb is the only thing on screen while recording.

> "Keep the number of prominent buttons to one or two per view." — HIG, Buttons

**P2 — Glass is for controls, never for content.**
The transcript is content. The status message is content. Neither gets glass, a border, or a shadow — only a plain surface and, when it must sit over an unknown desktop, the minimum scrim that keeps it legible. On the panel, exactly two things carry the material: the grouped control surfaces and the header's segmented control. Glass never wraps content.

> "Don't use Liquid Glass in the content layer." — HIG, Materials
> "Limit these effects to the most important functional elements in your app." — Adopting Liquid Glass

**P3 — Silence is the default.**
No label is shown unless it is currently true and currently useful. There is no tagline, no feature list, no "Saved" toast, no marketing copy, and no visible Save button — every control writes through as it changes, exactly as the system's own settings do. The status line is silent when nothing is happening.

**P4 — Colour means one thing.**
The app has no brand colour: the accent is inherited from the system (`systemPreferences.getAccentColor()` on macOS, a documented fallback elsewhere) and is never overridden. Colour is otherwise reserved for state, and the orb is the app's status indicator — the one place the guidelines allow it. The orb palette is fixed per state and never adaptive to the interface style, because a status light that changes colour with the theme reads as a rendering bug.

> "Avoid using the same color to mean different things." — HIG, Color
> "Avoid relying solely on color to differentiate … or communicate essential information." — HIG, Color

**P5 — System type where the system can, one bundled font where it cannot.**
The panel uses three type roles (title 15, body 13, caption 11) and nothing in between. Persian is set in Vazirmatn and Latin in Inter, both bundled locally and loaded from disk — see the decision log for why this deviates from "don't embed system fonts".

> "Consider using the built-in text styles." — HIG, Typography
> (Deviation recorded in §7. Everything else — colours, materials, controls — is the system's.)

**P6 — Motion explains, it does not decorate.**
While listening, every movement of the orb comes from the microphone: the low bands push the aura and the sphere, each cloud is driven by its own band. Nothing pulses on a timer. While transcribing, the microphone is closed, so the orb keeps a slow, even flow — no spinner, no rotating arc. Two state changes (the orb's palette, the transcript's appearance) are the only transitions.

> "Add motion purposefully … Don't add motion for the sake of adding motion." — HIG, Motion
> "In apps, generally avoid adding motion to UI interactions that occur frequently." — HIG, Motion

**P7 — The microphone is open only while recording.**
There is no always-on listener and no wake word: the microphone opens when a recording starts and closes the moment it stops. A feature that keeps the device open to wait for a phrase costs the user something every second of the day, and there is no on-device recogniser in this stack that could pay for itself. The shortcut is the trigger, and nothing listens in between.

**P8 — Honest about the platform.**
Transcription is a network call to the provider with the user's own key, and the documentation says so rather than implying anything runs locally. Typing into another app needs macOS Accessibility permission; when it is missing, the app names the settings pane to open. When a provider request is being retried, the screen says so instead of showing an unexplained wait. Every limitation is stated where the user meets it.

---

## 3. Design tokens

### 3.1 Colour

No decorative colours are defined. Everything is either semantic, or the inherited accent.

| Role | Token | Notes |
| --- | --- | --- |
| Window surface | `--window-tint` | Sits over the window's native vibrancy (macOS) / acrylic (Windows) |
| Grouped control surface | `--glass`, `--glass-line`, `--glass-hi` | The material; the top hairline is the material's specular edge, not a decorative highlight |
| Field / control fill | `--field`, `--field-line` | |
| Primary text | `--text` | |
| Secondary text (labels, captions) | `--text-2`, `--text-3` | |
| Separator | `--hair` | Row separators only, inset past the leading icon |
| Accent | `--accent` | Set at runtime from the system accent; never authored |
| Success / warning / failure text | `--ok`, `--warn`, `--err` | Text only, never a background |
| Orb palettes | §4.5 | The status indicator's fixed colours |

The panel never mixes more than one tinted surface at a time. Raw hex appears only inside the token block.

Two sanctioned exceptions, each with a reason:

0. The app icon is the orb itself — the same object the app draws, with the warm "live" palette, as a lit sphere on a tile sized to Apple's grid. The icon is the product's identity, not UI chrome, and it is generated from the same design (`scripts/make-icons.js`) rather than drawn as a flat shape, so the Dock and the window look like one thing. It is the only place raw colour lives outside the token block, and it is a 1024px asset, not a surface.
1. `--glyph-ink` is white. It is drawn on a tinted sphere, where the normal text colour would fail contrast; white-on-colour on a status mark is what the system itself does.
2. The orb palettes in §4.5 are fixed sRGB values. The orb is a status indicator — the one place colour is allowed — and it is deliberately not adaptive to the interface style, because a status light that shifts with the theme reads as a rendering bug.

### 3.2 Typography

| Element | Token | Family |
| --- | --- | --- |
| Panel title | `--text-title` (15px, 600) | Inter / Vazirmatn |
| Row labels, field text, status line | `--text-body` (13px; labels 500) | Inter / Vazirmatn |
| Transcript | `--text-read` (15px) | Inter / Vazirmatn |
| Captions, footnotes, key chips | `--text-caption` (11px) | Inter / Vazirmatn |
| Timer | 56px, 500, rounded, tabular numerals | `ui-rounded` → SF Pro Rounded, else Inter |
| Orb message | 11px | Inter / Vazirmatn, centred |

Three roles, nothing between them. No light weights. No fourth size to make one label fit.

### 3.3 Spacing

Base unit 4. The panel uses this subset and nothing else:

```
4 · 8 · 12 · 16 · 20 · 24
```

Row height is a fixed 40; row separators are inset 24 from the leading edge so they start where the label does, not where the icon does.

### 3.4 Shape

| Element | Shape | Rationale |
| --- | --- | --- |
| Grouped surface | 12px radius | One radius for containers |
| Key chip, segmented thumb, icon button | 5–6px radius | Nested inside a container |
| Switch track / knob | Capsule / circle | The platform's own control |
| Orb | Circle (54pt sphere inside a 96pt canvas) | The hero object is a sphere, not a squircle |
| Record button | Circle, 84pt, one glass element per screen | A round hero control is a circle |

Text fields and pickers carry no chrome at all, so they need no radius: the label
above the value and the chevron on the trailing edge are the entire affordance.

Concentric nesting only: an inner element is never given a radius that is not derivable from its parent.

### 3.5 Motion

| Event | Animation | Duration |
| --- | --- | --- |
| Hover / press on a control | `filter` brightness, one curve | 0.18s |
| Segmented control selection | thumb translate, one curve | 0.18s |
| Orb level | redrawn per frame from the analyser | none — must not lag the audio |
| Orb sphere + aura | follows the level, attack 0.55 / release 0.14 per frame | smoothing, not an animation |
| Orb palette change | per-frame blend toward the next palette | 600ms |
| Transcript appearance | the console moves up, the transcript fades in | 0.18s |
| Timer | text changes once per whole second, digits fixed-width | 1s |
| Meter | redrawn every frame, never animated: it must not lag the audio | — |
| Pushed settings | slide from the inline end, which mirrors for RTL | 0.18s |
| Reduce Motion | all custom motion removed; the orb keeps level and palette only | — |

Banned: any decorative loop; any animation on a control the user touches every session; any spinner.

### 3.6 Icons

Drawn inline from the Lucide set (MIT), 16px, 1.7px stroke, `currentColor`, never filled.

| Use | Icon |
| --- | --- |
| API key / model / spoken language | `i-key`, `i-spark`, `i-globe` |
| Shortcut / record button | `i-command`, `i-mic`, `i-stop` |
| Settings / back | `i-gear`, `i-chevron` |
| Copy / paste / launch at login | `i-copy`, `i-paste`, `i-power` |
| Prompt / transcript | `i-pencil`, `i-quote` |
| Show key / hide key | `i-eye`, `i-eye-off` |
| Refresh | `i-refresh` |
| Outcome (overlay only) | check / alert |

The app icon is the one icon that is not Lucide: it is the orb, baked to PNG by `scripts/make-icons.js`. macOS gets a full canvas of art, because the system masks it to Apple's own 824-in-1024 body and adds the edge light and the shadow; Windows and Linux get the same art pre-shaped, since nothing does that for them. It never appears inside the window; the window's own header carries the app's name instead.

Every icon-only control carries an `aria-label`, set from the same dictionary as its visible sibling. Icons are decorative (`aria-hidden`) when a visible label already names the row.

---

## 4. Components

### 4.1 The recorder (root)

The whole product, on one screen. The header carries the app's name on the centre line; the screen it sits on is already named by what it shows.

```
┌──────────────────────────────────────────────┐
│  Guya                              ⧉   ⚙︎  │  ← copy appears only with text
├──────────────────────────────────────────────┤
│                                              │
│         ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁                   │  ← CONTENT: drawn meter, 48 bars
│                                              │
│                  0:07                        │  ← CONTENT: timer
│                                              │
│              Listening…                      │  ← CONTENT: one line of state
│                                              │
│   The transcript appears here as one plain   │  ← CONTENT: transcript
│   block of text, and scrolls.                │
│                                              │
├──────────────────────────────────────────────┤
│                   ◉                          │  ← CONTROL: the one glass element
└──────────────────────────────────────────────┘
```

| State | Meter | Timer | Status line | Button |
| --- | --- | --- | --- | --- |
| idle, no transcript | baseline, tertiary | 0:00 | "Tap to dictate" | mic, glass |
| recording | live levels, primary | counting | "Listening…" | stop glyph, stained material |
| transcribing | settles to the baseline | a caption under the orb | "Transcribing…", or "Trying again (2 of 3)…" | dimmed, not interactive |
| result | baseline | the finished duration | empty | mic |
| failed | baseline | 0:00 | the error sentence, in red | mic |

Rules:

- **The hero is centred in the space that is left over**, not in the window: with no transcript the console is centred; with a transcript it sits at the top and the transcript takes the remaining space and scrolls. Nothing is positioned with offsets.
- **While a transcript is being fetched the orb takes over the console.** The microphone is closed, so the meter has nothing to say; the orb appears in its cool "working" palette and its clouds keep flowing. It is the app's own mark doing the waiting — not a spinner, and not a second visual language. The timer steps down to a caption underneath it.
- **The meter is a drawn shape**, never a row of icons: 48 capsule bars fed at 20 Hz from the overlay, which is where the microphone actually lives. At rest the bars hold a visible baseline — a hairline would read as a separator, not as a meter. It is hidden from assistive technology: it is a redundant visualisation of the timer and the status line.
- **The timer is always present, including 0:00**, so nothing on the screen jumps when recording starts. It is built from whole seconds by hand (`m:ss` is not a localised string and the label is redrawn every second) and the digits are fixed-width so they cannot jitter.
- **The status line says only what is true now**, and the line is reserved so the hero never shifts when the message changes. It is empty at rest and empty when a transcript is on screen — the text is the message.
- **One prominent control.** The record button is the only glass element on the screen and the only thing that is ever red. While working it is not interactive, so a second tap cannot start a second upload.
- **An unconfigured app opens Settings instead of recording**, rather than failing after the user has spoken.
- The floating orb is not repeated here: while the window is open the meter and the timer already carry the state, and the orb belongs to the desktop.

### 4.2 Settings (pushed)

Pushed over the recorder from the toolbar, with a back chevron. Everything the app can be configured with lives here and nowhere else.

```
┌──────────────────────────────────────────────┐
│  ‹                     Settings              │
├──────────────────────────────────────────────┤
│  Gemini                                      │
│  ┌────────────────────────────────────────┐  │
│  │ API KEY                                │  │  ← small label, value under it
│  │ ••••••••••                       👁    │  │
│  │ ─────────────────────────────────────  │  │
│  │ Model            gemini-2.5-flash  ⌄ ⟳ │  │  ← value + chevron, trailing
│  └────────────────────────────────────────┘  │
│  Audio is uploaded to the Gemini API …       │  ← footnote, never a row
│                                              │
│  Dictation                                   │
│  ┌────────────────────────────────────────┐  │
│  │ Recording shortcut      ⇧ ⌘ Space      │  │
│  │ Spoken language         Auto detect  ⌄ │  │
│  │ Stop after silence      10 seconds   ⌄ │  │
│  │ Attempts                3            ⌄ │  │
│  │ Instructions & context                 │  │
│  │ [ … ]                                  │  │
│  └────────────────────────────────────────┘  │
│  For your own vocabulary. Optional.          │
│                                              │
│  Output      Copy · Paste · Launch at login  │
│  About       Interface language · Version    │
└──────────────────────────────────────────────┘
```

Rules:

- **No Save button.** Text fields commit on blur (and on Enter); switches, pickers and the shortcut commit immediately. A rejected shortcut reverts, and the revert is announced — it is state the user must know about.
- **Each group has a title above it and, when it needs one, a sentence below it.** Explanations never sit in a row: rows stay scannable.
- **Text fields carry no chrome**: a small label, then the value, on the group's own surface. Pickers put the value on the trailing edge with a chevron. Switches sit on the trailing edge.
- **The key is checked when it is entered**, not behind a button: the model list is the positive confirmation, and a rejected key is a sentence in the form's status line.
- **The model row is a picker with a "Custom…" entry.** Provider model names change faster than releases.
- **Back is the chevron, and Escape closes the screen** — but Escape is only the recorder's stop control while the microphone is open.
- **Attempts is a short, closed list** (1, 2, 3, 5 — three by default). A dropped connection or a 503 should not cost the user a paragraph they just spoke, and only failures another attempt could fix are retried; a rejected key is not one of them. Each attempt has its own 45-second budget rather than one long wait, and the backoff is exponential with jitter so a shared outage is not re-created by every client retrying in step.
- **The silence stop is a short, closed list** (off, 3, 5, 10, 20 seconds) and its durations are locale-formatted. It is the setting most worth having: waiting for it is the longest part of the round trip, so the honest place to tune the wait is here rather than in the code.
### 4.3 The shortcut field

Key combinations read left-to-right in every language — a Persian reader is shown `⇧ ⌘ Space`, not a mirrored string. The field is a row of key caps, not a text input; clicking it starts capture, Esc cancels, and a combination with no modifier is refused with a sentence.

### 4.4 The orb

One object, three meanings, no container.

- 54pt sphere on a 96pt canvas with the aura reaching at most 1.65× the radius, so the glow can never be clipped into a shape.
- Three layers: a soft aura, a glass sphere with four drifting colour clouds, and a top-left specular with a bottom shade so the sphere reads as a sphere.
- The clouds are clipped to the sphere, drawn as multi-stop radial gradients (never as a canvas blur: a filter makes the compositor's output in a transparent window unpredictable, and the gradients are cheaper).
- While listening, the four clouds are the four frequency bands of the live input, smoothed with a fast attack and a slow release. The sphere's scale follows the low bands; the aura's spread and brightness follow the level. **Nothing moves on a timer.**
- While transcribing, the microphone is closed: the clouds keep a slow, even swirl and the sphere breathes gently. There is no spinner and no rotating arc.
- Appearance: light and dark variants follow the system; the clouds are pastel on a light desktop and luminous on a dark one.

The orb is the only element the app draws outside its panel, and it is deliberately not clickable: the overlay window is click-through, so it can never steal a click from the app underneath.

### 4.5 The overlay

A 220×148 click-through window, horizontally centred near the top of the display the pointer is on, above other windows and on every Space.

- The orb, and one line of state under it when there is something to say ("No API key yet.", an error, "Transcript ready.").
- It is shown while the microphone is open and hidden when it is not.
- It never takes focus: the app the user is dictating into keeps its caret, which is what makes "paste automatically" land in the right window.

### 4.6 Orb palettes

Colour is the state, and the states can never be confused with each other.

| Phase | Palette | Reads as |
| --- | --- | --- |
| Listening | `#ff6c76 · #ff965c · #ff5684 · #ffc470` | warm — the microphone is live |
| Working | `#808cf8 · #60def0 · #74a6ff · #a2c8ff` | cool — not live, busy |
| Done | `#40d696 · #56e2aa · #34be8c · #7aeabe` | the transcript is ready |
| Failed | `#ffa848 · #ffbe6e · #f6943c · #ffcd8c` | amber, never red |

Failed is amber rather than red, and always carries the exclamation glyph, so it cannot be mistaken for the live state — those are exactly the two states a user must never mix up.

---

## 5. Content and copy rules

| Rule | Example |
| --- | --- |
| Sentence case everywhere | "Start recording", not "Start Recording" |
| The window title is the app's name | "Guya"; the settings screen is titled "Settings", and neither is a sentence |
| Titles ≤ 15 characters | "Guya", "Settings" |
| No exclamation marks, no "Oops" | "No speech detected in that audio." |
| Errors say what happened and what to do | "Microphone access for Guya is turned off." → with the settings pane offered |
| No marketing language in the app | — |
| Numbers are locale-formatted | counts via `Intl`, never string-concatenated |
| Every string exists in both languages | one dictionary, asserted by a test |
| No emoji | — |

Error strings are part of the design. Every failure maps to one of a small, fixed set of honest, actionable sentences — a raw provider message is never shown.

---

## 6. Accessibility

- Every icon-only control has a `label`/`aria-label` fed from the same dictionary as its visible text, so a missing string is caught by the dictionary test rather than by a silent blank.
- The record button announces its state, not just its icon.
- The interface language sets the document language and direction; Persian is RTL end to end, and key combinations stay LTR inside it.
- Reduce Motion removes every custom animation: the orb keeps its level and its palette and stops drifting.
- Light and dark are both first-class, checked in both.
- No information is carried by colour alone: done and failed carry a glyph, recording carries motion and the status line, and a rejected shortcut carries a sentence.
- Controls meet desktop minimums (24–28px for a hit target, 42px rows) rather than the 44pt of the touch platform.

---

## 7. Decision log

| Decision | Alternative rejected | Why |
| --- | --- | --- |
| Accent inherited from the system | A brand colour | A personal utility has no identity to express, and the system accent is what every other window on the machine uses |
| No Save button; controls write through | A Save button and a dirty state | The system's own settings do not have one; a Save button invents a state the user can forget to resolve |
| Model select + "Custom…" | Closed list, or a bare text field | Model names change faster than releases; both alternatives are worse for one of the two cases |
| The transcript is plain text on the surface | A bordered textarea | The container adds a shape without adding information, and a disabled-looking field implies an action that is not there |
| One interface on three systems | A native look per platform | The product is small enough that a second design language would cost more than it explains, and the guidelines it follows are about hierarchy and restraint rather than about macOS. Only the material and what the OS actually permits differ |
| Automatic paste is disabled on Linux, with a sentence saying why | Offering a switch that cannot work | Typing into another app is a keystroke through the OS; Linux has no supported route, so the row is honest instead of decorative |
| The product is called Guya (گویا) | The old name, V2T | The old name said nothing; "گویا" means articulate, speaking — the thing the app does — and it is four letters that both languages can say |
| Every visible string comes from the dictionary, asserted by a test | Writing copy in the markup where it is read | A UI with two languages drifts the moment a sentence is written in one of them; the test fails the build when non-Latin text or a hardcoded label appears outside the dictionary, and when a key the markup asks for does not exist |
| System menus are role menus | English labels written by the app | macOS already has these menus, in the user's language |
| A transcript carries its own direction | The interface's direction, or `dir="auto"` | Content written in Persian must read right-to-left even in an English window, and `dir="auto"` looks only at the first strong character, so an English word opening a Persian sentence would flip the whole paragraph. The direction is decided per paragraph by counting strong characters, and the browser's bidi algorithm then places any foreign word correctly inside it |
| The main process is split by responsibility | One long `main.js` | A dictation touches the shortcut, the OS, the provider and the windows; keeping each of them in its own module is what makes a bug read as one file. The layering is checked, not just intended: leaves first, composition root last, no cycles |
| Messages cross the process boundary as keys, never as sentences | Localizing in the main process and sending the text | A renderer that is switched to the other language after the message was created cannot re-say a sentence it was handed; the key lets it translate at the moment it draws |
| The window title is the app's name | A task title ("Dictate"), which is what this document first specified | A window title is where the user reads what the window is for, and this window has exactly one job — so the task title ("Dictate") only ever restated the screen below it, and it disagreed with the name the user sees in the Dock and the menus. The reversal is recorded here rather than quietly dropped: the earlier rule was about not wasting the titlebar, and the app's own name is not a waste |
| Settings pushed inside the recorder window | A second window, or tabs | The product is one screen plus everything-else; a pushed view keeps one window, one title, and one place to look, and Escape already means "go back" |
| The meter is drawn on a canvas | A row of icon bars | Icons are for controls; a level meter is a shape, and a symbol-soup waveform is a recognisable amateur tell |
| The meter is fed from the overlay over IPC | The panel opening its own microphone | One process owns the microphone. A second capture would fight it for the device and double the permission surface |
| The timer is built from whole seconds | A duration format style | A format style on a label that changes every second is work for nothing, and `m:ss` reads the same in every language |
| The fake-mic tests drive the panel with conditional waits | Fixed sleeps | The first two runs of these tests failed on timing, not on behaviour; a check that waits for the state it asserts is the only kind that stays honest |
| Orb colour per state | One fixed palette | Colour is the fastest way to answer "is it listening?", and the answer must never be ambiguous |
| Failed is amber, not red | Red for failure | Red now means "live"; two states that mean opposite things cannot share it |
| Level-driven everything while listening | A fixed idle pulse | A pulse that is not the voice tells the user something false about the input; the orb is data, not decoration |
| No spinner while transcribing | A rotating arc | A spinner is the most generic mark in software and it fights the material; the orb's own flow carries "working" without a second visual language |
| Canvas gradients instead of canvas blur | `ctx.filter = blur()` | The blur makes the compositor's alpha handling in a transparent window unpredictable, and it was measurably clipped at the box edge |
| Aura capped at 1.65× the sphere, canvas 96 vs sphere 54 | Aura sized to the level with no cap | An aura larger than its canvas is a rounded rectangle, not a glow |
| Bundled Vazirmatn + Inter | System font stack | Persian in the system stack falls back to a face that is not designed for UI; Vazirmatn is drawn for it and Inter is its Latin companion. Recorded as a deliberate deviation |
| The wake word was removed after it shipped | Keeping it, or a native recogniser | It needed the microphone open all day and a round trip to the provider for every phrase, so it was both the largest privacy cost and a source of latency in the product. On-device recognition would need a native engine and a model download, which is a different app |
| Escape captured only while recording | Escape registered globally | A globally captured Escape breaks every other app on the machine |
| The transcript's job description lives in systemInstruction | A sentence in the user turn | It is the model's role, not the user's message: it never changes with the user's wording, and keeping it out of the user turn keeps that turn short |
| The answer length is capped to the audio length | No cap | A model that keeps writing after the speech ends costs the user seconds of wait for text nobody asked for |
| The provider connection is pre-connected | Paying the handshake after the user stops | The DNS and TLS round trip happens while the user is still speaking |
| Extended thinking switched off for flash models | Leaving the default | Thinking buys nothing for transcription and costs seconds of the wait, which is the thing the user actually feels |
| A retry says so, with numbers | Failing silently and retrying | "Trying again (2 of 3)…" explains the wait instead of restating it |
| The window buttons are hidden until the pointer reaches for them | Reserving a band of the titlebar for them | The buttons belong to the window, not to the app: hiding them until hover is what lets the title sit on the centre line and the controls sit against the opposite edge in every language, with nothing pre-reserved |
| A setting that needs a system permission is refused until the system grants it | Letting the setting be on and failing later | "Paste automatically" cannot work without Accessibility, so the switch goes back to off, macOS is asked to put up its own dialog, and the form shows one sentence and the two actions that fix it. The app never claims a capability the platform has not granted |
| The app asks macOS to say it, instead of only saying it itself | A sentence in a footnote | `isTrustedAccessibilityClient(true)` is the only way the user hears it in the system's own words, and polling lets the app notice the moment it is granted and finish the job |
| The back control sits on the leading edge, with the window buttons given a band above the toolbar | Reserving a fixed column of the toolbar for the buttons | The reserved column pushed the back control 76px into the window, where it read as floating and was the first thing reported as a bug. The buttons belong to the window, not to the toolbar row, so they get the padding above it and every control keeps its own edge: back on the leading edge, actions on the trailing edge, in both directions |
| Back is the chevron, Escape, or Cmd+[ | The chevron alone | Escape is the recorder's stop control while the microphone is open, so the settings screen needs a way back that is never ambiguous — and Cmd+[ is where macOS puts "back" |
| The app icon is a lit sphere on a tile that fills the canvas, generated by `scripts/make-icons.js` | Ship the shaped squircle with its margins, or a drawn symbol | The icon is the orb, and a sphere only reads as one if it is shaded: a normal per pixel, one light, a tight specular, a rim, a bounce and a shadow where the system does not draw one. The canvas is filled edge to edge because macOS 26 masks the icon itself, and art that does not reach the edge is treated as a photograph: the system discards the baked shape, rescales the content to about 55% and puts its own background behind it, which is the tile-inside-a-tile this icon shipped with until it was measured. The Windows and Linux copies are the shaped variant since nothing masks them there |
| The silhouette is fitted to the system, not chosen | Exponent 5, the usual squircle rule of thumb | Measured against one of Apple's own icons as macOS 26 renders it here: the body is 824 inside 1024, the straight edge ends 230px in, and the corner profile matches a superellipse at exponent 4.3 to 1.1px over 1024. Exponent 5 is visibly squarer than what the system ships. On macOS this only affects the artwork's own edge treatment, because the mask is the system's; on Windows and Linux it is the silhouette the user sees |
| The macOS icon path is set explicitly in `build.mac.icon` | Letting electron-builder find it | Left to itself it built the `.icns` from `build/icons/1024x1024.png` — the Linux folder — so macOS received pre-shaped art and rescaled it. The bundler's default search is not the file you think it is; naming it is one line and removes the guess |
| The floating orb is suppressed while the recorder window is in front | Always showing it | The window already shows the meter, the timer and the orb; the same thing twice on one screen is noise |
| The silence stop is a setting, not a constant | 10 seconds, decided in code | The wait for it is the longest part of the round trip, so the user is the right person to decide how long it is |
| Silence stop uses an adaptive floor | A fixed threshold | A fixed threshold either never fires in a noisy room or fires mid-sentence in a quiet one |
| The overlay is click-through | A clickable orb | The overlay exists while the user is typing elsewhere; a clickable overlay would steal a click and the caret with it |
| No tray icon | A menu-bar status item | It competed with the panel for the same job and its icon was the least legible thing the app drew |
| Vanilla renderers, no framework | React + a component library | The whole UI is one panel and one canvas; a framework would add a build step and a dependency tree to save a few lines |
| `app://` protocol for the renderers | `file://` | A real origin is what makes the CSP, the worklet module and the bundled fonts behave on every platform |
| A token set in CSS | Values per rule | Spacing and type drift one declaration at a time; a closed set is what keeps a redesign from unravelling |

**Also deliberately not implemented, and why:**

- History, favourites, search over transcripts — out of scope; the clipboard is the history.
- A theme picker or accent picker — the system already owns both, and honouring it is the point.
- Live preview of the transcript while speaking — the provider returns text at the end; a fake local preview would be a promise the app cannot keep.
- Volume/keyboard-shortcut presets — one shortcut that the user sets once is a smaller product.
- Click-through toasting, sounds, or notifications — the orb and the clipboard cover both outcomes, and a desktop utility that beeps is a desktop utility that gets uninstalled.

---

## 8. Amateur-tell checklist

Run through this before calling any screen finished.

- [ ] No border or stroke on content. Borders belong to controls and grouped surfaces only.
- [ ] No shadow under any control; the only shadow is the sphere's own, and the material's specular edge on a grouped surface.
- [ ] No decorative gradient, glow or blur.
- [ ] One accent, inherited from the system, meaning one thing.
- [ ] No hard-coded colour outside the token block.
- [ ] Spacing values all drawn from `{4, 8, 12, 16, 20, 24}`.
- [ ] Three type roles and no more; no light weights.
- [ ] No hard-coded radius that is not one of the two container/control radii.
- [ ] Exactly one prominent button on the screen.
- [ ] Every custom control has a press state; every icon-only control has a label.
- [ ] The window title is the app's name (or the screen's, in settings), ≤ 15 characters, never a sentence.
- [ ] No motion on a frequently repeated interaction; custom motion respects Reduce Motion.
- [ ] Nothing moves on a timer while the microphone is live — every movement is the input.
- [ ] No spinner.
- [ ] The status line is empty at rest, and the line is reserved so nothing shifts.
- [ ] Nothing in the titlebar reserves space for the window buttons, and the title is on the centre line in both directions.
- [ ] A control named for its own vocabulary starts empty, never pre-filled with text the app also sends behind the scenes.
- [ ] A setting that depends on a system permission cannot be on without it, and the refusal names the pane and offers it.
- [ ] Switch the interface to the other language and read every screen: no word from the first language survives, including placeholders, tooltips and the window's menus.
- [ ] Read a transcript in the language the interface is *not* in: it is laid out the way its own language is read, and a foreign word inside it is placed correctly.
- [ ] The hero is centred in the leftover space, not in the window.
- [ ] The timer is present in every state, including 0:00.
- [ ] The meter is drawn, not assembled from icons, and is hidden from assistive tech.
- [ ] Exactly one element on the screen is glass, and exactly one thing is ever red.
- [ ] Settings rows are scannable: labels in rows, explanations in footnotes.
- [ ] Verified in light and dark, in RTL and LTR, and with Reduce Motion on.
- [ ] Every error is a sentence a person would say out loud.
- [ ] No emoji, no exclamation marks, no marketing copy.

---

## 9. Sources

- **Apple Human Interface Guidelines** — Materials · Color · Typography · Layout · Motion · Buttons · Toolbars · Playing haptics
- **Adopting Liquid Glass** — Apple Developer Documentation
- **Electron** — `BrowserWindow` (`vibrancy`, `backgroundMaterial`, `setIgnoreMouseEvents`), `globalShortcut`, `systemPreferences.getAccentColor`, `protocol.handle`, `net.fetch`
- **Chromium** — Web Audio (AudioWorklet, AnalyserNode), Canvas 2D, `prefers-reduced-motion`, `prefers-color-scheme`
- **Provider APIs** — Gemini `generateContent` with inline audio; the audio-listening and transcription guides
- **Fonts** — Vazirmatn (SIL OFL 1.1), Inter (SIL OFL 1.1); Lucide icons (MIT)

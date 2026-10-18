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
The panel uses four type roles (title 15, body 13, read 14, caption 11) and nothing in between. Persian is set in Vazirmatn and Latin in Inter, both bundled locally and loaded from disk — see the decision log for why this deviates from "don't embed system fonts".

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
| Reset a field to its default | `i-reset` |
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
| idle, no transcript | baseline, tertiary | 0:00 | "Tap to record" | mic, glass |
| recording | live levels, primary | counting | "Listening…" | stop glyph, stained material |
| transcribing | settles to the baseline | a caption under the orb | "Transcribing…", or "Trying again (2 of 3)…" | Cancel, glass |
| result | baseline | the finished duration | empty | mic |
| failed | baseline | 0:00 | the error sentence, in red | mic |

Rules:

- **The hero is centred in the space that is left over**, not in the window: with no transcript the console is centred; with a transcript it sits at the top and the transcript takes the remaining space and scrolls. Nothing is positioned with offsets.
- **While a transcript is being fetched the orb takes over the console.** The microphone is closed, so the meter has nothing to say; the orb appears in its cool "working" palette and its clouds keep flowing. It is the app's own mark doing the waiting — not a spinner, and not a second visual language. The timer steps down to a caption underneath it.
- **The meter is a spectrum**, and it is drawn, never assembled from icons: 48 capsule bars fed at 20 Hz from the overlay, which is where the microphone actually lives. Each bar is one frequency band over a logarithmic scale from 60 Hz to the top of what the capture can hear — so the bars around 1 kHz move when someone speaks at 1 kHz, and the rest stay still. A bar rises fast and falls slowly. A row of bars fed by one loudness number looks like an equaliser and is not one: it tells the user their microphone is working at a volume, and nothing about what it hears. At rest the bars hold a visible baseline — a hairline would read as a separator, not as a meter. The whole thing is hidden from assistive technology: it is a redundant visualisation of the timer and the status line.
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
│  Recording                                   │
│  ┌────────────────────────────────────────┐  │
│  │ Recording shortcut      ⇧ ⌘ Space      │  │
│  │ Spoken language         Auto detect  ⌄ │  │
│  │ Stop after silence      10 seconds   ⌄ │  │
│  │ Attempts                3            ⌄ │  │
│  │ System prompt                     ↺     │  │  ← label + reset, trailing
│  │ [ the instructions sent with every     │  │  ← always left-to-right
│  │   recording, in English ]              │  │
│  └────────────────────────────────────────┘  │
│  This text is sent with every recording.     │
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
- **The system prompt is the user's.** The field shows the text the app sends with every recording, and it is a field, not a footnote: someone who wants a different vocabulary, a different level of punctuation or a different language altogether can write it. It is laid out left-to-right in both directions, because what it holds is written in English — the same reason the shortcut field is never mirrored. The reset control beside the label puts the app's own text back.
- **The prompt field is the one place a non-user-facing string is on screen**, and it is there because the user asked to see what the model is told. It is not translated, so switching the interface language does not change it.
- **Attempts is a short, closed list** (1, 2, 3, 5 — three by default). A dropped connection or a 503 should not cost the user a paragraph they just spoke, and only failures another attempt could fix are retried; a rejected key is not one of them. Each attempt has its own 45-second budget rather than one long wait, and the backoff is exponential with jitter so a shared outage is not re-created by every client retrying in step.
- **Both waits are a short list plus "Custom…"**, and their durations are locale-formatted. The list is what is offered, not what is allowed: the store keeps any value in range, so 4.5 seconds survives a restart. These are the settings most worth having — waiting for the end of speech is the longest part of the round trip — so the honest place to tune the wait is here rather than in the code.
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
- It never takes focus: the app the user is speaking into keeps its caret, which is what makes "paste automatically" land in the right window.

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
| The main process is split by responsibility | One long `main.js` | A recording touches the shortcut, the OS, the provider and the windows; keeping each of them in its own module is what makes a bug read as one file. The layering is checked, not just intended: leaves first, composition root last, no cycles |
| Messages cross the process boundary as keys, never as sentences | Localizing in the main process and sending the text | A renderer that is switched to the other language after the message was created cannot re-say a sentence it was handed; the key lets it translate at the moment it draws |
| The window title is the app's name | A task title named for the app's job, which is what this document first specified | A window title is where the user reads what the window is for, and this window has exactly one job — so that task title only ever restated the screen below it, and it disagreed with the name the user sees in the Dock and the menus. The reversal is recorded here rather than quietly dropped: the earlier rule was about not wasting the titlebar, and the app's own name is not a waste |
| Settings pushed inside the recorder window | A second window, or tabs | The product is one screen plus everything-else; a pushed view keeps one window, one title, and one place to look, and Escape already means "go back" |
| The meters work in decibels relative to the room, per band | The analyser's own byte data, which is what this shipped with | Bytes are decibels already, with the floor and ceiling fixed by the browser, so the same face sat at 40% of the meter in a quiet room and 90% in a noisy one, and there was no telling a fan from a voice. Each band now keeps its own smoothed level, its own floor and its own slowly falling ceiling, so a bar is loud when it is loud *for this room* and noise reads zero. Attack and release are time constants, so the response does not change with the frame rate |
| The bands are mel spaced | Logarithmically, which is what this shipped with | An octave is not what the ear counts, and the bottom of the range is where speech lives: with 48 mel-spaced bands over 80 Hz upward, the lowest band is about three bins wide at a 16 kHz context instead of two bars showing the same bin |
| The orb's size and aura follow a voice envelope, and its colours follow the bands | Both from the bands | A bass band moves when a lorry goes past. The envelope is the same measurement the gate makes — the level relative to the room — so the orb pulses with the voice rather than with the traffic, and the four colours still carry which frequencies are there |
| The measurement runs on a timer, not on a frame | Computing the spectrum in the orb's animation frame, which is what this shipped with | A window that is not on screen has its frames paused by the browser, and the panel's meter would freeze with it while the overlay kept listening — the meter is data, and data does not belong in a render loop |
| The panel reads its colour once per phase change, and rebuilds the transcript only when the text changes | Reading both every frame and every state push | `getComputedStyle` forces a style recalculation, thirty times a second in the middle of a drawing loop, and rebuilding the transcript's paragraphs throws away the user's selection while they are reading |
| The meter is a drawn spectrum | A row of icon bars, or one loudness number repeated across the row | Icons are for controls; a level meter is a shape, and a symbol-soup waveform is a recognisable amateur tell. The bands are real or it is a lie: a row fed by a single level moves as one and says nothing about what the microphone hears, which is what an equaliser is for |
| The audio graph is built at start-up and only the microphone is opened on demand | Building the context, the worklet and the analyser when the user presses the key | They cost a context, a file fetch and a compile, and none of them needs the device. Building them while the user is still deciding is the difference between a recording that begins with the first word and one that begins after the first word |
| The platform's own speech processing stays on | Asking for the raw signal, which is what this shipped with for one release | It was a reasonable-sounding idea and it was wrong, and measurement settled it: with automatic gain off, speech arrives at about a fourteenth of the level it does with it on (0.009 against 0.128 RMS). Quiet enough that nothing recognises it as speech — including this app, which then reported "no speech detected" for every recording. The filters exist for calls, but the alternative is a microphone that hears nothing. Echo cancellation is the one that stays off: it selects the system's voice-processing unit, which is what ducks a voice mid-sentence |
| A recording with no speech in it is never sent to the model | Sending it and letting the model decide | Asked to transcribe a quiet room, a model answers with something plausible — a greeting, a thank-you, a sentence nobody said, in a language nobody spoke — and the reader cannot tell that apart from their own words. So the app decides first, using a level measured between the two: on this machine a quiet room means 0.0024 RMS with a 0.0052 ninetieth percentile, and someone talking means 0.0145 with a 0.0431. The floor sits inside that gap and rises in a room that is loud by itself. It takes both a total — a third of a second — and a proportion — an eighth of the recording — so a door closing in a silent room is not speech. The obvious alternatives were measured too and thrown out: the zero-crossing rate was 0.064 against 0.089, and the level's own spread 0.69 against 0.78 |
| The model is given an empty answer to give | Telling it to return nothing, which is what this shipped with | A model with no legitimate way to say "there was nothing" fills the silence instead: measured here, one quiet room came back as an invented sentence and another as an apology for not being able to transcribe. The answer is a JSON object — `{"speech": false, "text": ""}` — so saying nothing is a shape it can take and be believed, and the app has a decision to read rather than a sentence to guess at. Prose is still accepted, because a model that ignores the shape still transcribes |
| The key and the model are checked by reading the model resource | Asking for a small generation | A generation drags in the model's output-token floor, a quota spent on a real request and candidates that can come back empty, and every one of those reads to the user as "your key is wrong" while the key is fine. The read answers the two questions that matter and answers them the same way every time. One retry, only for a server that hiccuped |
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
| The spoken language is stated once, in the user turn | In both the system instruction and the user turn, which is what this shipped with | The same sentence in both halves of the request is noise, and the user turn needs a text part beside the audio anyway. The system instruction is now exactly what the settings field holds, which is also what the field promises the user |
| The instructions to the model are one English text, not a translation of the interface | A prompt per interface language, which is what this shipped with | There are two audiences here and the dictionary is only for one of them. The user reads the window; the model reads the job description. Nobody in the window ever sees this text, so translating it bought nothing, doubled what had to be kept in step, and made the transcript depend on the window's language — a Persian prompt was doing the work of an English one in an English window and the other way round. It is precise in exactly one place now (`src/shared/prompt.js`), and a test fails if a second language creeps back in |
| The rules name what matters, not just the verbatim rule | "Transcribe it verbatim" and nothing else | A bare verbatim instruction still leaves the hard cases to the model's judgement: a speaker switching language mid-sentence, a word spoken in another script that has to stay in it, a number said as words, a name that must not be re-spaced, a phrase that sounds like a command, a pause that wants a paragraph. Each of those is a rule in the prompt with its own line, because each of them is a way a transcript comes back subtly wrong |
| Nothing spoken is ever an instruction | Assume the speaker is honest | The audio is untrusted input that reaches a model with tools it could be asked to use. The prompt says outright that a spoken command, question or "ignore your instructions" is text to write down and not to act on |
| Only the speech is uploaded, with half a second of air on each side | Uploading the whole recording | The timer keeps counting while the user decides to stop, and on a slow uplink those seconds are the most expensive part of the round trip. The gate already knows which frames were speech, and the 450 ms margins are wider than its own onset (100 ms) and hang-over (400 ms), so the words are never at an edge. The timer still shows the full length: that is what the user recorded, and the trim is the app's business rather than theirs |
| The answer length is capped generously, and the cap is a ceiling rather than a target | A tight cap tuned to the audio length | Nothing is billed or waited for beyond what the model writes, so a tight cap buys nothing and costs a great deal: Persian and Arabic run several tokens per word, and a model that thinks spends part of the same budget before the first word. A tight cap is therefore how an answer arrives empty — and empty is read as "no speech detected" |
| Thinking is held down per model family: off where it is allowed, its minimum where it is not | One thinking setting for every model | Flash accepts a zero budget and Pro does not, so Pro was getting nothing at all while the prompt asked for no thinking. Pro gets 128 — its smallest — and its cap carries the reserve for it, because thinking tokens and answer tokens share the same budget |
| The provider connection is pre-connected, again when a recording ends | Pre-connecting only when one starts | The DNS and TLS round trip happens while the user is still speaking. A long recording idles that socket out, so the moment the user stops is the moment to warm it again |
| A refusal is remembered for the session | Finding out again with every recording | A model that rejects the JSON answer shape costs one failed round trip to discover, not one per recording |
| A 400 that names a feature is answered by asking again without it; anything else is final | Treating every 400 as a request to try again | The features are droppable one at a time — thinking, then the answer shape — and a model that will not take JSON still transcribes. A 400 that names the key, or names nothing at all, is an answer, not an invitation |
| Retry waits come from the server when it says, and the whole thing has a deadline | A fixed backoff, and as long as it takes | A 429 carrying `retryDelay: 37s` cannot recover in the 1.3 seconds three quick attempts take, and a per-day quota cannot recover at all: those fail with the wait in the message instead of spending attempts. Everything, attempts and waits included, ends inside 90 seconds — after that the user is not waiting, they have given up |
| A half-written answer is salvaged or refused, never shown | Passing whatever came back | With the answer cut off by the token limit, the raw text is `{"speech": true, "text": "سلام من امروز` — half a JSON object, which is not what the speaker said and is not fit to paste into their app. The `text` field is taken when it can be read, and the answer is refused when it cannot |
| A hung request is a timeout, not "offline" | One error for everything that did not answer | The wait was the app's own budget running out, and saying the network is down sends the user to check their connection for something that never left the machine |
| The model list is what can take audio | Every model that can generate | A key that can reach text-to-speech, image, embedding or live models was offering them for transcription, and a list with the wrong things in it is worse than a short one |
| A retry says so, with numbers | Failing silently and retrying | "Trying again (2 of 3)…" explains the wait instead of restating it, and the number is a promise the app has to keep: 90 seconds is the whole budget |
| The window buttons are hidden until the pointer reaches for them | Reserving a band of the titlebar for them | The buttons belong to the window, not to the app: hiding them until hover is what lets the title sit on the centre line and the controls sit against the opposite edge in every language, with nothing pre-reserved |
| The window is dragged by an empty strip at the top, not by its header | Making the header the drag region, which is what this shipped with | A header that drags the window also summons the window buttons when the pointer enters it, and the control in that corner — the back chevron — is the one people reach for. The click went to the buttons that had just appeared and the control looked broken. The strip holds nothing at all, so no control can ever be underneath it, and the window still moves by its top edge |
| The panel accepts the first mouse | Requiring a click to focus the window first | This window spends its life in the background, because the shortcut works from any app. Arriving at it and clicking a control is one gesture; in the default state the first click only focused the window, which reads as a control that needs two clicks |
| A setting that needs a system permission is refused until the system grants it | Letting the setting be on and failing later | "Paste automatically" cannot work without Accessibility, so the switch goes back to off, macOS is asked to put up its own dialog, and the form shows one sentence and the two actions that fix it. The app never claims a capability the platform has not granted |
| The settings field holds the instructions themselves | The field as a place for the user's own vocabulary, appended to the user turn, with the field starting empty — which is what this shipped with | Two texts doing one job: rules in code the user could not see, and a box the user could type into that only added to them. The box is the instructions now. Whatever is in it is what the model is told, which means the window shows exactly what the app does, and both the vocabulary and the rules are the user's to change |
| The instructions are seeded into the field once, from a revision marker, never compared against the text | Deciding by looking at what is in the field | Comparing contents to decide whether to overwrite cannot tell an untouched install from a user who deliberately wrote something else, so it either clobbers an edit or leaves an old vocabulary-only value doing a whole job description's work. A revision marker in the settings file answers the one question that matters — was this written before the field changed meaning — and the merge on that upgrade keeps whatever the user had written underneath the rules |
| The prompt field is left-to-right in both directions | Following the interface, as the transcript does | A transcript carries its own direction because its language varies; this field does not vary. It holds English, and English laid out right-to-left in a Persian window is unreadable. The shortcut field follows the same rule for the same reason |
| The app asks macOS to say it, instead of only saying it itself | A sentence in a footnote | `isTrustedAccessibilityClient(true)` is the only way the user hears it in the system's own words, and polling lets the app notice the moment it is granted and finish the job |
| The back control sits on the leading edge, with the window buttons given a band above the toolbar | Reserving a fixed column of the toolbar for the buttons | The reserved column pushed the back control 76px into the window, where it read as floating and was the first thing reported as a bug. The buttons belong to the window, not to the toolbar row, so they get the padding above it and every control keeps its own edge: back on the leading edge, actions on the trailing edge, in both directions |
| Back is the chevron, Escape, or Cmd+[ | The chevron alone | Escape is the recorder's stop control while the microphone is open, so the settings screen needs a way back that is never ambiguous — and Cmd+[ is where macOS puts "back" |
| The API key is encrypted with the system's own service | A plain field in a JSON file, which is what this shipped with | The key is the user's, and a settings file is a text file: it is written with `safeStorage` whenever the system offers a service (the keychain on macOS, DPAPI on Windows), and read back from either form, so an install from before this keeps working and is encrypted on its next save. A system that offers none keeps the plain field, because the alternative is an app that cannot hold a key at all |
| A settings file that cannot be parsed is kept, not overwritten | Falling back to defaults, which is what this shipped with | Defaults look like an empty app: a corrupt file would take the key with it and the user would have to go and find it again. It is renamed beside itself and the app starts clean, which is recoverable |
| A save that failed says so | Writing and hoping | The window showed the new value either way, and the user found out at the next launch. The store reports whether the bytes reached the disk and the form repeats it |
| One control saves one field | Sending the whole form on every change, which is what this shipped with | A save triggered by one picker carried every field, including the prompt the user was still typing — and the reply then overwrote it. Each control sends what it changed, and a field that has focus is never written over by a state push |
| A shortcut made of punctuation is kept, not read back from the settings | Looking up what to unregister when a shortcut changes, which is what this shipped with | The store already holds the NEW value by the time the change is applied, so the app unregistered the key the user had just asked for and left the previous one held forever — one shortcut that never worked and one that could not be released. What is registered is a fact about the system, and it is kept where it happens |
| Control on macOS is Control | Mapping the secondary modifier to Super, which is what this shipped with | Super is Command on a Mac, and Command is already the primary modifier: every Control shortcut silently meant Command, so the key the user chose was not the key they got |
| A shortcut made of punctuation is kept | A pattern that allowed letters, digits and `+` only | The form could produce Control+Shift+`,` or Alt+`/`, and the store threw them away without saying anything: the shortcut worked until the app was restarted, which is the worst way to find out |
| Escape while the app is waiting cancels, and the record button becomes Cancel | Leaving the user nothing while a request retries | Waiting for the provider is the longest part of a recording — with retries it ran into minutes — and Escape was released the moment the microphone closed, so there was no way out of it at all. Escape is held while the app is busy and means "stop and transcribe" only while recording; the one prominent control does the same thing, and says so |
| A second press while the microphone is opening cancels it | Ignoring presses that arrive too early | The press is the user saying "never mind", and the only alternative is a recording that starts after they walked away. Two presses in the same instant are still one intention: a held key repeats, so a press inside 350 ms is not a second press |
| A result belongs to the session that asked for it | Applying whatever comes back | A cancelled request, a watchdog that already gave up, or a recording that started since: any of those means the answer is nobody's — and applying it would put a sentence the user cancelled onto their clipboard and into whatever app had focus |
| Every failure releases the microphone | Letting the capture end on its own | A failure that leaves the capture running is a failure that leaves the microphone open, and with "stop after silence" off it stays open for good. The overlay is told to abort before the error is even drawn |
| Nothing is listening while the answer is being fetched | Leaving the capture graph running | The recording is over and the WAV is made; a live context with a connected destination keeps the output device busy and the CPU awake for no reason |
| A crash in a renderer ends the session instead of hanging it | Waiting for an answer that cannot come | The overlay owns the microphone. If it dies, the app would sit in "starting" for ten seconds and then fail with a message about the microphone that says nothing about what happened; the window is rebuilt on the next use and the session ends now |
| The app icon is a lit sphere on a tile that fills the canvas, generated by `scripts/make-icons.js` | Ship the shaped squircle with its margins, or a drawn symbol | The icon is the orb, and a sphere only reads as one if it is shaded: a normal per pixel, one light, a tight specular, a rim, a bounce and a shadow where the system does not draw one. The canvas is filled edge to edge because macOS 26 masks the icon itself, and art that does not reach the edge is treated as a photograph: the system discards the baked shape, rescales the content to about 55% and puts its own background behind it, which is the tile-inside-a-tile this icon shipped with until it was measured. The Windows and Linux copies are the shaped variant since nothing masks them there |
| The silhouette is fitted to the system, not chosen | Exponent 5, the usual squircle rule of thumb | Measured against one of Apple's own icons as macOS 26 renders it here: the body is 824 inside 1024, the straight edge ends 230px in, and the corner profile matches a superellipse at exponent 4.3 to 1.1px over 1024. Exponent 5 is visibly squarer than what the system ships. On macOS this only affects the artwork's own edge treatment, because the mask is the system's; on Windows and Linux it is the silhouette the user sees |
| The macOS icon path is set explicitly in `build.mac.icon` | Letting electron-builder find it | Left to itself it built the `.icns` from `build/icons/1024x1024.png` — the Linux folder — so macOS received pre-shaped art and rescaled it. The bundler's default search is not the file you think it is; naming it is one line and removes the guess |
| The floating orb is suppressed while the recorder window is in front | Always showing it | The window already shows the meter, the timer and the orb; the same thing twice on one screen is noise |
| The silence stop is a setting, not a constant | 10 seconds, decided in code | The wait for it is the longest part of the round trip, so the user is the right person to decide how long it is |
| Two waits instead of one | A single "stop after silence" | "Nobody has spoken yet" and "they have finished speaking" are different questions with different answers, and one number cannot be both. As one number it was the *longest*: ten seconds of the user's life after every sentence, and ten seconds of silence uploaded with every auto-stopped recording — the biggest hidden wait in the app. They are 3 s and 8 s now, and both are settings |
| The other platforms' paste path is tested from here | Trusting a machine that only runs macOS | Windows and Linux cannot be run from this laptop, but the one piece of code that differs per platform and has actually broken — finding the paste helper on Linux, and which of the three to prefer — can be: the module is reloaded with `process.platform` faked and a PATH that contains tools the test creates. That is the Windows and Linux paste paths, asserted here, with macOS and Windows' built-in tools as the control |
| Every release runs natively on every machine it can: one file per architecture, named for it | The runner's own architecture, which is what this shipped with — and then one installer holding both, which is what followed | A release that only runs natively on the machine that built it is not a release: an Intel Mac and an ARM Windows machine were both left out. Packing both architectures into one file put them back in, at the price of an installer that is twice the size for a machine that can run half of it — 207 MB became 98 MB once they were separate. So each system ships one file per architecture with the system and the architecture in the name (`Guya-1.0.0-Windows-x64-Setup.exe`, `Guya-1.0.0-macOS-arm64.dmg`), and Linux keeps each ecosystem's own convention — `x86_64` for an AppImage, `amd64` for a deb |
| The macOS release is a disk image, not a zip | Shipping the zip electron-builder makes anyway | The zip exists so an auto-updater can diff it, and this app has no auto-updater by design — it is a file list entry that exists for a mechanism the product does not have. It also halves the number of macOS assets, which was the point of naming them by architecture in the first place |
| The release notes are written from the commits, in sections | GitHub's generated notes, which are what the first releases used | A generated list of merge commits with a comparison link tells a reader nothing about what changed in the app. `scripts/notes.js` groups the commits by what they are (features, fixes, performance), keeps the scope each commit declared, drops the bookkeeping, and ends with the table that matters: which file to download for which machine. A first release has nothing to compare against, so it opens with what the app is instead of a list of the commits that built it |
| Closing the window quits everywhere but macOS | Two windows, one of which is never closed | The overlay is hidden rather than closed and stays alive for the app's lifetime, so `window-all-closed` never fires: on Windows and Linux, where closing the window is how the user quits, the app kept running with nothing on screen |
| A crash while nothing is recording is not a microphone problem | Reporting it as one, which is what this shipped with | The overlay renderer dying between recordings has nothing to do with the microphone, and telling the user about it opened the panel with an error about a device that is fine. Only a crash *during* a session ends it; otherwise the window is quietly rebuilt |
| Hiding the overlay stops the orb's frame loop, whether or not it was ever shown | Leaving it running, which is what this shipped with | The renderer is deliberately not throttled — it owns the microphone — so its animation frame keeps running at full rate while the window is hidden, drawing about six radial gradients per frame for as long as the app is open. Nothing ever set the idle state, so the loop only ever started. Hiding the window now says so, and a recording in progress is not interrupted by it: the overlay can be hidden while the microphone is open. The signal is sent even when the window was never displayed — which is the in-app case, where the panel is in front for every recording — because that is the case where it would otherwise draw for the rest of the session. Measured on this machine: about 2% of a core while hidden, against about 29% while it was still drawing |
| The orb's decay is measured in milliseconds, not frames | Per-frame factors | A decay that is twice as fast on a 120 Hz display is a different object on a different machine, and the frame rate also depends on what else is drawing. The pixel ratio is re-read every time the window is shown for the same reason: the window is positioned on the display under the pointer, which can be a different one, and the window itself never resizes |
| The overlay is shown before anything the press has to check | Showing it once the session is ready to start, which is what this shipped with | Everything after the keypress is fast, but it is not instant: the key check, the permission preflight, and then the renderer's own device request. Measured on this machine, the orb appeared 197 ms after the press in steady state and 945 ms on the first press after launch — and the largest part of it was that the window was asked to appear while the renderer's main thread was already blocked in `getUserMedia`, so it could not paint. Showing it first, before the work that can take a moment, puts it on screen in about 20 ms, and everything after it either replaces what is on screen with a session or flashes its refusal on top of it |
| Opening the microphone looks like waiting, and going live looks like a change | Both looking the same, which is what this shipped with | The device takes 150–800 ms to open, and seconds on a Bluetooth headset. With the same warm colour for both states the user starts talking into a microphone that is not listening yet and loses their first words — the single most-reported bug in shortcut-driven dictation. The cool palette is already the app's "working" colour, so "starting" uses it, the warm palette is reserved for the microphone actually being live, and the blend to it is fast (120 ms) so it reads as an event rather than a drift |
| The audio context is suspended thirty seconds after the last recording, not at once | Suspending it the moment a recording ends | Suspending and resuming are not free, and the resume used to sit *after* the device request: every recording after the first paid both waits in sequence. The microphone stream still closes immediately — that is the part that matters — and a running context with no source connected costs nothing worth measuring |
| Pre-roll buffering the microphone was rejected | Keeping the device open so the first word is never lost | Recording into a rolling buffer means the microphone is open before the user asks, which is what rule 4 of the working agreement exists to prevent: an always-on capture is the privacy cost of a wake word without even the convenience of one |
| An empty answer is asked for again; only the model can say there was no speech | Treating both as "no speech detected", which is what this shipped with | They are different facts. An empty response is the provider having nothing to say — a dropped answer, a truncated one — and asking again is free; "speech: false" is the model's verdict about the audio, and only the model can make it. Conflating them reported a provider hiccup as a recording with no speech in it |
| A model that says there was no speech gets the same audio, louder, once | Asking again with the identical audio | At temperature 0 the same audio produces the same answer, so a second attempt is only worth making if something changed. The one thing that helps a model that could not make out quiet speech is the same speech made louder: the recording's peak is brought up (capped at 8×, and only when there is more than 20% to gain) for one attempt |
| The capture worklet hands over its partial chunk on stop, and is told to forget it on start | A node that only ever posts full chunks, which is what this shipped with | A 1024-frame buffer means up to 64 ms of the last audio was thrown away at every stop, and — because the node outlives the recording — the same partial chunk was then prepended to the *next* recording: 56 ms of the previous session at the start of the new one. The overlay asks for the tail (and waits for the answer) before it builds the WAV, and resets the node before connecting a new stream |
| The room level is a low quantile of the last two and a half seconds, and the threshold is a ratio over it | An absolute level measured on one machine, which is what this shipped with after that correction | An absolute number is a fact about one microphone: on a quieter input — a headset, another room — it is never reached, so the gate flags nothing and the app reports "no speech" while the orb is visibly moving. A quantile of what the last two and a half seconds actually sound like scales with whatever device is in use, and it is a quantile rather than the single quietest frame because one silent buffer from a driver could otherwise pin the floor at nothing for a whole session. The floor follows a quieter room at once, rises while nobody is talking, and rises fast for sound that is *steady* — a fan, a hiss, the platform's gain settling — because a voice modulates far too much to look steady |
| While a voice is present the floor may rise by only 5% a second | Letting it chase the minimum of the window at 1.3× a second, which is what the first version did | During fourteen seconds of continuous speech that took the floor from 0.0016 to 0.0056: the orb's level fell from 0.94 to 0.35 in the middle of the sentence and quiet words came close to being dropped. Speech must not be able to raise its own threshold |
| Known limitation: the first recording in a room much louder than the last one is partly mis-flagged | Pretending it is not there | Until the gate has heard the room it has nothing to compare against, so its first seconds in a new, louder room look like speech. It cannot hang — the endpointer still fires — and the next recording starts calibrated because the overlay carries the room's level over from the previous one. Recording this here is the honest alternative to tuning a constant until the scenario passes on one machine |
| Onset needs a tenth of a second, and a stop needs four tenths of a hang-over | Reacting to every frame | A single frame above the threshold used to start "voice", which is a keyboard click or a door, and the natural gaps between words were the other half of the same problem: the hang-over and the hysteresis are what keep a sentence in one piece |
| The room's level is remembered between recordings | Starting blind every time | It is the same room, and its quiet level is the most useful thing a finished recording knows. The next one starts already calibrated, which is what makes the second recording in a noisy room behave |
| A duration may be any value, and the picker offers a few | A closed list the store enforces | The list is what is offered, not what is allowed: someone who wants 4.5 seconds types it, and the store keeps it. The picker would only ever be a convenience the user has to argue with |
| The overlay is click-through | A clickable orb | The overlay exists while the user is typing elsewhere; a clickable overlay would steal a click and the caret with it |
| No tray icon | A menu-bar status item | It competed with the panel for the same job and its icon was the least legible thing the app drew |
| Vanilla renderers, no framework | React + a component library | The whole UI is one panel and one canvas; a framework would add a build step and a dependency tree to save a few lines |
| `app://` protocol for the renderers | `file://` | A real origin is what makes the CSP, the worklet module and the bundled fonts behave on every platform |
| A token set in CSS | Values per rule | Spacing and type drift one declaration at a time; a closed set is what keeps a redesign from unravelling |
| A sentence about the request is not a transcript | Trusting whatever prose comes back when the model ignores the answer shape | A silent recording came back as "Here is the JSON requested:" and that line was typed into the user's window — a sentence nobody said, in the place their words were supposed to go. The empty answer exists (`{"speech": false}`) and the prompt asks for it, so an announcement of the answer is read as the same verdict in prose. The rule needs two signals at once — a line that stops at its own colon, or a short line that names the format it was asked for and announces it — because dropping a real transcript is the worse failure: "send me the JSON file" is a sentence someone said, and it is kept |
| The refusal decides which permission pane is offered | Reporting every refused keystroke as Accessibility | macOS refuses a keystroke twice over and fixes it in two different panes: sending keystrokes at all is Accessibility (-1002), asking System Events to send it is Automation (-1743). A user who had granted one and not the other was sent to a pane that could not fix it, so the setting looked on, the permission looked on, and the paste never happened |
| The transcript is never typed into Guya's own window | Pasting wherever focus happens to be, as a function of the setting | With the recorder in front the same words are already on screen, and a keystroke aimed at it lands in a field nobody meant to write in — which reads as a paste that never happened |
| Closing the window leaves the app running, on every platform, and the settings screen is where it quits | Closing the window quits everywhere except macOS, which is what this shipped with | The shortcut is the whole product, so an app that stops working because its window was closed is not a background utility — and on Windows and Linux the window is closed with the system's own button. Taking the cross away leaves those two systems with no menu bar to quit from, so the settings screen carries the one control that quits, in the window they actually have. macOS keeps its menu and Cmd+Q, and there it is not shown |
| The shortcut portal is asked for on Linux | Registering the accelerator and assuming it fires | A Wayland client cannot grab a key: shortcuts are handed out by the desktop's portal. Without asking for it, `register` returns success and the key does nothing at all — the worst kind of broken, with no error to read and no switch to turn on |
| Escape is grabbed where it can be, and a failed grab is remembered as a failure | Assuming the grab worked because nothing threw | Where it is possible, another app may already hold Escape; recorded as captured, it would never be asked for again and the way out of a recording would be gone for the rest of the session. On Wayland it cannot be grabbed at all, which is said out loud: the shortcut itself still stops the recording, and so does the silence timer |
| While the user is choosing a shortcut, the app stops holding keys | Leaving the grab alone, which is what this shipped with | Windows gives a registered combination to its owner before any window ever sees the keystroke, so the field waiting for keys received none: "I press keys and nothing happens". Electron has the switch for exactly this screen (`globalShortcut.setSuspended`). A Wayland session cannot suspend anything — the grab belongs to the desktop — and says so instead of pretending |
| The combinations the system owns are refused while the user is pressing keys, per platform | One reserved list, written for macOS | The list held `Cmd+Q` and `Cmd+W` and not `Alt+Space`, which Windows keeps for the window menu: the form accepted it, the store saved it, `RegisterHotKey` refused it, and the app then held no shortcut at all while the field showed one. Each system now answers for its own keys, and the refusal appears on a line under the row rather than at the bottom of a scrolling form |
| Whether the shortcut is actually held is a state of the app, shown on the recorder | Trusting the value in the settings file | A registration can fail at launch — another app holding the combination for the moment — and the field kept displaying it while nothing was listening. The recorder now says so, the settings row repeats it, and the app asks the system again every time the window is opened, because there is nothing else the user can press to find out |
| A configured launch shows the window | Starting in the background with no window at all, which is what this shipped with | On macOS the Dock and the menu make that survivable; on Windows and Linux there is no other way in, so the first click of the icon appeared to do nothing — that process finds the single-instance lock taken, quits, and the *next* click is what shows the window. A launch by the login item does not open one, and Windows says which it was through the argument the item is registered with |
| The page a key comes from is three lines under the field that wants one | A link in the README, or a paragraph of help text | The one thing every new user has to do before the app does anything is get a key, and the answer belongs where the field is rather than in another document. Closed until asked for, because it is read once |
| The picker offers the models this app is built against, and the provider's catalogue on request | Whatever the API answers with, unfiltered | The list this app ships is the four models it is tested with; "Refresh models" replaces it with what the user's own key can reach. Image, research and agent models are hidden from that answer — an image model beside a transcription model is a choice someone makes by mistake and then reads as the app being broken |
| A word spoken in another language keeps its own language and its own letters | "Each part keeps its own language, in its own script", which is what this shipped with | Speaking Persian and saying an English term in the middle of a sentence came back with that term spelled in Persian letters: the language of the sentence took over the words that were not in it. The principle was not enough — a model needs the failure named and the letters it should produce — so the instructions name it, in both directions, and say that a name keeps the form it was spoken with and an uncertain word is written as it sounded rather than fitted to the sentence. The per-recording line was part of the cause: "The audio is in Persian" reads as an instruction about the whole transcript, so it says the main language now |
| The key that cannot be read this launch is kept, not deleted | Trusting the settings object to hold everything the file holds | The ciphertext lived only on disk, because nothing but the store needs to see it. A launch that could not decrypt it — a keyring that is not up yet, a keychain entry the app may no longer read — read the key as empty and wrote the file without it on the next save, so changing the interface language destroyed the user's key. An unreadable key is kept in memory as ciphertext and written back as it was; a save that carries the key field is a decision about the key, and the ciphertext goes then |
| A setting the system will not honour is refused, with a reason | Setting it and reporting success | "Launch at login" on Linux called an API that does nothing there — a desktop starts an application from its own autostart entry — and reported success: the switch stayed on across restarts and the app was never there after a login. The store now takes the refusal and reverts, and the window says whose job it is. The same rule decides the microphone preflight, which read every answer but "granted" as a refusal — including the "unknown" Windows reports before the question is asked |
| A paste that did not happen is said out loud | Writing it to the error slot the window renders only in the error phase | The phase is "done" when the transcript arrives, so the most common paste failures — a helper installed but not running, a keystroke refused for a reason that is neither permission — were completely silent: the text was on the clipboard and nowhere else, and nothing said why. The orb flashes it and the window repeats it, while the transcript stays on the clipboard |
| The wait before the transcript is typed is part of the session | A timer of its own, outside the bookkeeping | It outlived a cancel: record, cancel, start something else, and the cancelled transcript was typed into whatever was in front 350 ms later. It is cleared with the session's other timers, and the answer is dropped if the session it belongs to is over |
| The overlay hides when nothing has asked for it | Hiding it when its page finishes loading | A recording that begins while the page is still loading — the first press after launch, or the press after a crashed renderer, which rebuilds the window — had the window shown and then hidden from under it by its own load event: a live microphone, no orb, and no way to tell Guya was listening. Whether the overlay is wanted is a fact the window keeps, and a page that never loads ends the wait for the commands queued behind it |
| A shortcut that is not held is not displayed | Keeping the store's value when a change failed | When the key the user asked for was taken and the previous one could not be put back — another app took that too — the settings file kept the old combination and the field showed it, while the app held nothing. The file says "none" and the field invites a press. An empty string is a real value to the store for the same reason |
| A microphone that stops delivering ends the recording | Trusting the track to keep its promise | Everything a recording does is driven by samples arriving: the endpointer, the meter, the silence timers. A track that exists, has not ended, and is delivering nothing — a device handed to another application, a context the system suspended, a headset that changed profile — froze the meter, never produced the silence that ends a recording, and left it running to the five-minute cap with the audio after the handover missing. Four seconds without a block of samples ends the recording and keeps what was captured |
| An emptied "Custom…" duration keeps the wait in force | Saving 0 for an empty or unreadable field | 0 means Off, so opening "Custom…" on a wait and clicking away turned the wait off: the value in the field was blank (or whatever was typed there last time), and the round trip to the store wrote it. The field starts from the value in force and an empty one keeps it |
| Two locales, and one file per architecture | Every Chromium locale, and both architectures inside one installer | The app speaks Persian and English and was carrying 55 locale files — 48 MB that is never loaded; two are asked for now, and the Windows build went from a 106.8 MB installer to 98.4 MB. An installer that packed both architectures was 207 MB for a machine that can run half of it, and it put two files on the release page that looked identical and were not. Both architectures are still shipped, one file each, and the name says which is which |

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
- [ ] Four type roles and no more; no light weights.
- [ ] No hard-coded radius that is not one of the two container/control radii.
- [ ] Exactly one prominent button on the screen.
- [ ] Every custom control has a press state; every icon-only control has a label.
- [ ] The window title is the app's name (or the screen's, in settings), ≤ 15 characters, never a sentence.
- [ ] No motion on a frequently repeated interaction; custom motion respects Reduce Motion.
- [ ] Nothing moves on a timer while the microphone is live — every movement is the input.
- [ ] No spinner.
- [ ] The status line is empty at rest, and the line is reserved so nothing shifts.
- [ ] Nothing in the titlebar reserves space for the window buttons, the title is on the centre line in both directions, and no control is anywhere the buttons can appear.
- [ ] A field whose label shares its line with an action puts the label on the leading edge and the action on the trailing one.
- [ ] The system prompt field shows exactly what is sent, starts as the app's own text, is left-to-right in both directions, and has a way back to the default.
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

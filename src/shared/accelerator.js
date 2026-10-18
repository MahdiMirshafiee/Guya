/*
 * Translates a browser KeyboardEvent into an Electron accelerator string, and
 * renders accelerators for display. Shared by the settings UI (capture) and the
 * main process (pretty printing of the registered shortcut).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuyaAccelerator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var IS_MAC = typeof navigator !== 'undefined' ? /Mac/i.test(navigator.platform) : process.platform === 'darwin';
  var IS_WINDOWS = typeof navigator !== 'undefined' ? /Win/i.test(navigator.platform) : process.platform === 'win32';

  /* Renderers that already know the real platform (via the preload bridge) can
   * pin it, so display() never depends on navigator.platform. */
  function setPlatform(platform) {
    IS_MAC = platform === 'darwin';
    IS_WINDOWS = platform === 'win32';
  }

  /* Named keys are resolved from event.code, which is keyboard-layout
   * independent; punctuation falls back to the produced character so a shifted
   * press such as Shift+, is still captured. */
  var CODE_NAMES = {
    Space: 'Space',
    Enter: 'Return',
    NumpadEnter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Escape: 'Escape',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert'
  };

  var CODE_PUNCTUATION = {
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Minus: '-',
    Equal: '=',
    Backquote: '`'
  };

  /* Punctuation reached through event.key when the code is unknown. */
  var PUNCTUATION = {
    ' ': 'Space',
    ',': ',',
    '.': '.',
    '/': '/',
    ';': ';',
    "'": "'",
    '[': '[',
    ']': ']',
    '\\': '\\',
    '-': '-',
    '=': '=',
    '`': '`',
    '\t': 'Tab',
    Enter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Escape: 'Escape',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  };

  /* Combinations the system owns, per platform. These are refused while the user is
   * pressing keys, because the alternative is what happened on Windows: the form accepted
   * `Alt+Space`, the store kept it, the registration failed, and the app then held no
   * shortcut at all while the field showed one. The OS will not hand these out —
   * `RegisterHotKey` returns false for the Alt and Win combinations below, and an X11
   * window manager grabs its own — so they are answered where the user is looking. */
  var RESERVED_MAC = [
    'CommandOrControl+Q',
    'CommandOrControl+W',
    'Command+Tab',
    'Command+Space',
    'CommandOrControl+Control+Q',
    'Alt+F4'
  ];
  var RESERVED_WINDOWS = [
    'Alt+Tab',
    'Alt+Space', // the window menu
    'Alt+Escape',
    'Alt+F4',
    'Control+Escape',
    'Control+Shift+Escape',
    'Control+Alt+Delete',
    'Super+Tab',
    'Super+Space',
    'Super+D',
    'Super+E',
    'Super+L',
    'Super+R'
  ];
  var RESERVED_LINUX = [
    'Alt+Tab',
    'Alt+Space',
    'Alt+F4',
    'Control+Alt+Delete',
    'Super+Tab',
    'Super+Space',
    'Super+D',
    'Super+L'
  ];

  function reservedList() {
    if (IS_MAC) return RESERVED_MAC;
    return IS_WINDOWS ? RESERVED_WINDOWS : RESERVED_LINUX;
  }

  function keyFromEvent(event) {
    var code = event.code || '';
    if (Object.prototype.hasOwnProperty.call(CODE_NAMES, code)) return CODE_NAMES[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (Object.prototype.hasOwnProperty.call(CODE_PUNCTUATION, code)) return CODE_PUNCTUATION[code];
    if (Object.prototype.hasOwnProperty.call(PUNCTUATION, event.key)) return PUNCTUATION[event.key];
    return null;
  }

  /* Returns { accelerator } or { errorKey } — never a partial shortcut. */
  function fromKeyboardEvent(event) {
    if (['Meta', 'Control', 'Alt', 'Shift'].indexOf(event.key) !== -1) return {};

    var key = keyFromEvent(event);
    if (!key) return { errorKey: 'ui.shortcutUnsupported' };

    var parts = [];
    var primary = IS_MAC ? event.metaKey : event.ctrlKey;
    var secondary = IS_MAC ? event.ctrlKey : event.metaKey;
    if (primary) parts.push('CommandOrControl');
    /* On macOS the Control key is Control; Super is Command, which is already the
     * primary modifier. Mapping both to Super made every Control shortcut mean
     * Command, which is a different shortcut on that machine. */
    if (secondary) parts.push(IS_MAC ? 'Control' : 'Super');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');

    var modifierCount = parts.length;
    var isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    if (modifierCount === 0 && !isFunctionKey) {
      return { errorKey: 'ui.shortcutNeedsModifier' };
    }

    parts.push(key);
    var accelerator = parts.join('+');
    if (reservedList().indexOf(accelerator) !== -1) {
      return { errorKey: 'ui.shortcutReserved' };
    }
    return { accelerator: accelerator };
  }

  var TYPED_NAMES = {
    CommandOrControl: '⌘',
    Command: '⌘',
    Super: '⌘',
    Control: '⌃',
    Ctrl: '⌃',
    Alt: '⌥',
    Shift: '⇧',
    Return: '↩',
    Space: 'Space',
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→'
  };

  /* macOS writes modifiers as ⌃⌥⇧⌘, Windows as Ctrl+Alt+Shift+Win. */
  var MAC_ORDER = { Control: 0, Alt: 1, Shift: 2, CommandOrControl: 3, Command: 3, Super: 3 };
  var WIN_ORDER = { CommandOrControl: 0, Control: 0, Super: 1, Command: 1, Alt: 2, Shift: 3 };

  /* Splits an accelerator into display labels: ['⇧','⌘','Space'] on macOS,
   * ['Ctrl','Shift','Space'] on Windows. */
  function displayParts(accelerator) {
    if (!accelerator) return [];
    var mac = IS_MAC;
    var order = mac ? MAC_ORDER : WIN_ORDER;
    var modifiers = [];
    var keys = [];

    accelerator.split('+').forEach(function (part) {
      if (Object.prototype.hasOwnProperty.call(order, part)) modifiers.push(part);
      else keys.push(part);
    });
    modifiers.sort(function (a, b) {
      return order[a] - order[b];
    });

    return modifiers.concat(keys).map(function (part) {
      if (mac) return TYPED_NAMES[part] || part;
      if (part === 'CommandOrControl' || part === 'Control' || part === 'Ctrl') return 'Ctrl';
      if (part === 'Command' || part === 'Super') return 'Win';
      if (part === 'Return') return 'Enter';
      return part;
    });
  }

  function display(accelerator) {
    return displayParts(accelerator).join(IS_MAC ? '' : '+');
  }

  return {
    fromKeyboardEvent: fromKeyboardEvent,
    display: display,
    displayParts: displayParts,
    setPlatform: setPlatform,
    isMac: function () {
      return IS_MAC;
    }
  };
});

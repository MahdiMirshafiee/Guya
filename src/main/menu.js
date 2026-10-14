/*
 * Guya — the application menu.
 *
 * On macOS a menu is not optional: without it the standard shortcuts (Cmd+C,
 * Cmd+V, Cmd+W, Cmd+Q) stop working in the app's own fields. Elsewhere there is
 * no menu, so there is none to get in the way.
 */
'use strict';

const { app, Menu } = require('electron');

const IS_MAC = process.platform === 'darwin';

function install() {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  /* Role menus, so macOS supplies their names in the user's language rather than
   * the app shipping English ones. */
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }]
      },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  );
}

module.exports = { install };

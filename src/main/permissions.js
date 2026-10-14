/*
 * Guya — what the renderers are allowed to ask the OS for.
 *
 * Nothing but the app's own pages may reach the microphone: they are served from
 * app://bundle/, and that origin is checked here rather than trusted.
 */
'use strict';

const { session } = require('electron');

const OWN_ORIGIN = 'app://bundle/';

function install() {
  const dflt = session.defaultSession;
  const isOwnPage = (webContents) => !!webContents && String(webContents.getURL()).startsWith(OWN_ORIGIN);
  dflt.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && isOwnPage(webContents));
  });
  dflt.setPermissionCheckHandler((webContents, permission) => permission === 'media' && isOwnPage(webContents));
}

module.exports = { install };

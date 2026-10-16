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
  /* `media` covers the camera too, and this app has no use for one: an app that can
   * ask for the camera is an app the user has to think about. */
  dflt.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const audioOnly = permission === 'media'
      && (!details || !details.mediaTypes || details.mediaTypes.every((type) => type === 'audio'));
    callback(audioOnly && isOwnPage(webContents));
  });
  dflt.setPermissionCheckHandler((webContents, permission) => permission === 'media' && isOwnPage(webContents));
}

module.exports = { install };

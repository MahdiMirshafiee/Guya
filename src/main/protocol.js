/*
 * Serves the renderer files from a real origin (app://bundle/...) instead of
 * file://. This is what makes AudioWorklet modules, ES modules and a strict CSP
 * behave the same on macOS and Windows.
 */
'use strict';

const path = require('path');
const { protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const SCHEME = 'app';
const HOST = 'bundle';
const ROOT = path.join(__dirname, '..'); // .../src

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ]);
}

function install() {
  protocol.handle(SCHEME, async (request) => {
    let filePath;
    try {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      filePath = path.join(ROOT, relative);
    } catch (_) {
      return new Response('bad request', { status: 400 });
    }
    if (!filePath.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (_) {
      return new Response('not found', { status: 404 });
    }
  });
}

function url(relativePath) {
  return `${SCHEME}://${HOST}/${relativePath.replace(/^\/+/, '')}`;
}

module.exports = { registerScheme, install, url, SCHEME };

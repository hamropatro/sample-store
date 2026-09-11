import { readFile } from 'node:fs/promises';

const MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', png: 'image/png' };

// An explicit allow-list, so no request can ever walk the filesystem.
const FILES = {
  '/': 'index.html',
  '/store.js': 'store.js',
  '/style.css': 'style.css',
  '/payment.js': 'payment.js',
  '/assets/everyday-tee.png': 'assets/everyday-tee.png',
  '/assets/everyday-tee-collar.png': 'assets/everyday-tee-collar.png',
  '/assets/everyday-tee-logo.png': 'assets/everyday-tee-logo.png',
  '/assets/everyday-tee-hem.png': 'assets/everyday-tee-hem.png',
  '/assets/everyday-tee-fabric.png': 'assets/everyday-tee-fabric.png',
  // Hamro Pay redirects here; both pages are the same status view.
  '/payment/success': 'payment.html',
  '/payment/failure': 'payment.html',
  '/payment/return': 'payment.html',
};

export function createStaticHandler(publicDir) {
  return async function serve(ctx) {
    const file = FILES[ctx.path];
    if (!file) return false;
    const extension = file.split('.').pop();
    ctx.bytes(200, await readFile(new URL(file, publicDir)), MIME[extension]);
    return true;
  };
}

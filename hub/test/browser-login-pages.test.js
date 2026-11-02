'use strict';
// The browser login only works if every page that needs the owner session loads local-auth.js first and waits for it.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('index.html loads local-auth.js before app.js, and app.js waits for hubAuthReady', () => {
  const html = read('index.html');
  const auth = html.indexOf('<script src="local-auth.js"></script>');
  const app = html.search(/<script[^>]+src="app\.js[^"]*"/);
  assert.ok(auth >= 0, 'index.html must load local-auth.js');
  assert.ok(app > auth, 'local-auth.js must come before app.js');
  assert.match(read('app.js'), /if \(window\.hubAuthReady\) await window\.hubAuthReady;/);
});
test('terminal.html loads local-auth.js before terminal-window.js, which waits for hubAuthReady', () => {
  const html = read('terminal.html');
  const auth = html.indexOf('<script src="local-auth.js"></script>');
  const terminal = html.indexOf('<script src="terminal-window.js"></script>');
  assert.ok(auth >= 0 && terminal > auth);
  assert.match(read('terminal-window.js'), /await window\.hubAuthReady/);
});
test('the recovery page loads /local-auth.js, and nothing but local-auth.js still mentions the old #auth= fragment', () => {
  assert.match(read('web-chat-recovery.html'), /<script src="\/local-auth\.js"><\/script>/);
  for (const name of ['index.html', 'terminal.html', 'web-chat-recovery.html', 'app.js', 'terminal-window.js']) assert.doesNotMatch(read(name), /#auth=/, name + ' must not use the old fragment login');
  // local-auth.js itself only REFUSES a stale fragment (exactly one mention)
  assert.equal((read('local-auth.js').match(/#auth=/g) || []).length, 1);
});

test('the login overlay is centred with margin:auto on the card, never with align-items on the scroll container', () => {
  // align-items:center on an overflow:auto flex container cuts off the top of a card taller than the viewport (high zoom, small window).
  const script = read('local-auth.js');
  assert.doesNotMatch(script, /alignItems|justifyContent/, 'the overlay must not centre with flex alignment');
  assert.match(script, /maxWidth: '520px',\s*margin: 'auto'/, 'the card must be centred with margin:auto');
  assert.match(script, /overflow: 'auto'/, 'the overlay must stay scrollable');
});

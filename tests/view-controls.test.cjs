const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../view-controls.js'), 'utf8');

function page({ coarse = false, lock } = {}) {
  const handlers = new Map();
  const addEventListener = (type, fn) => handlers.set(type, fn);
  const document = { addEventListener, visibilityState: 'visible' };
  const window = { addEventListener, screen: { orientation: { lock } },
    matchMedia: () => ({ matches: coarse }) };
  vm.runInNewContext(source, { document, window });
  function fire(type, props = {}) {
    const event = { cancelable: true, prevented: false,
      preventDefault() { this.prevented = true; }, ...props };
    handlers.get(type)?.(event);
    return event.prevented;
  }
  return { fire, document };
}

test('zoom gestures are blocked while scrolling and editing shortcuts remain usable', () => {
  const { fire } = page();
  assert.equal(fire('touchmove', { touches: [{}] }), false);
  assert.equal(fire('touchmove', { touches: [{}, {}] }), true);
  assert.equal(fire('touchstart', { touches: [{}, {}] }), true);
  assert.equal(fire('gesturechange'), true);
  assert.equal(fire('wheel', { ctrlKey: true }), true);
  assert.equal(fire('wheel', { ctrlKey: false }), false);
  for (const key of ['+', '=', '-', '_']) {
    assert.equal(fire('keydown', { key, ctrlKey: true }), true);
    assert.equal(fire('keydown', { key, metaKey: true }), true);
    assert.equal(fire('keydown', { key }), false);
  }
  for (const key of ['c', 'v', 'a', 'z', '0']) {
    assert.equal(fire('keydown', { key, ctrlKey: true }), false);
  }
});

test('portrait requests are mobile-only and recover from browser denial', async () => {
  let calls = 0;
  const lock = async orientation => {
    assert.equal(orientation, 'portrait-primary');
    calls++;
    throw new Error('NotAllowedError');
  };
  page({ lock });
  assert.equal(calls, 0);
  const mobile = page({ coarse: true, lock });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  mobile.document.visibilityState = 'hidden';
  mobile.fire('visibilitychange');
  assert.equal(calls, 1);
  mobile.document.visibilityState = 'visible';
  mobile.fire('visibilitychange');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.doesNotThrow(() => page({ coarse: true }));
});

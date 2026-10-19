const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('async function addFiles('), html.indexOf('function renderStaged()'));
const limitDefinition = html.match(/const MAX_FILE_BYTES\s*=\s*[^;]+;/)?.[0];
assert.ok(limitDefinition, 'MediaShare should define a shared upload size limit');
assert.match(limitDefinition, /50\s*\*\s*1024\s*\*\s*1024/);
const file = { name: 'slide.jpg', type: 'image/jpeg', size: 100 };

function fixture(overrides = {}) {
  const uploads = [], messages = [], rejected = [];
  const state = {
    uploading: false, composeView: { hidden: false }, staged: [], composeDrop: null,
    user: {}, submitBtn: {}, composeTitle: { close() {}, show() {} },
    isImageFile: () => true, rejectIntake: () => rejected.push(true),
    toast: message => messages.push(message), setStatus() {}, rememberUpload() {},
    renderStaged() {}, readAsDataUrl: async () => 'data:image/jpeg;base64,new',
    crypto: { randomUUID: () => 'request' },
    mediaApi: { upload: async (...args) => { uploads.push(args); return { id: 'saved' }; } },
    ...overrides
  };
  vm.createContext(state); vm.runInContext(limitDefinition + '\n' + source, state);
  return { state, uploads, messages, rejected };
}

test('uploads accept files through 50 MB and reject larger slides', async () => {
  const allowed = fixture();
  await allowed.state.addFiles([{ ...file, size: 50 * 1024 * 1024 }]);
  assert.equal(allowed.uploads.length, 1);

  const exceeded = fixture();
  await exceeded.state.addFiles([{ ...file, size: 50 * 1024 * 1024 + 1 }]);
  assert.equal(exceeded.uploads.length, 0);
  assert.deepEqual(exceeded.messages, ['Choose a slide no larger than 50 MB.']);
});

test('occupied and restored slots reject another image before uploading', async () => {
  for (const overrides of [
    { staged: [{ dataUrl: 'original' }] },
    { composeDrop: { id: 'saved' } },
    { composeView: { hidden: true } }
  ]) {
    const f = fixture(overrides);
    await f.state.addFiles([file]);
    assert.equal(f.rejected.length, 1);
    assert.equal(f.uploads.length, 0);
  }
  const busy = fixture({ uploading: true });
  await busy.state.addFiles([file]);
  assert.equal(busy.uploads.length, 0);
});

test('only an explicit replacement for the current saved slide bypasses the guard', async () => {
  const row = { id: 'saved', revision: 4 };
  const f = fixture({ composeDrop: row, staged: [{ dataUrl: 'original' }] });
  await f.state.addFiles([file], { replaceId: 'different-slide' });
  assert.equal(f.uploads.length, 0);
  await f.state.addFiles([file], { replaceId: 'saved' });
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0][2], row);
  assert.equal(f.state.staged[0].dataUrl, 'data:image/jpeg;base64,new');
});

test('failed replacement restores the old preview with its saved title record', async () => {
  const row = { id: 'saved', revision: 4 }, original = [{ dataUrl: 'original' }];
  const f = fixture({ composeDrop: row, staged: original,
    mediaApi: { upload: async () => { throw new Error('Offline'); } } });
  await f.state.addFiles([file], { replaceId: 'saved' });
  assert.equal(f.state.staged, original);
  assert.equal(f.state.composeDrop, row);
  assert.equal(f.state.uploading, false);
  assert.equal(f.state.submitBtn.disabled, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldDeferUpload, fingerprint, isPermanentUploadError, retryDelay } = require('../recorder-app');

test('defers the active Mayhem match until its final result exists', () => {
  const active = { id:'123', queueId:2400, win:null };
  assert.equal(shouldDeferUpload(active, { state:'captured', queueId:2400 }, '123'), true);
  assert.equal(shouldDeferUpload({ ...active, win:true }, { state:'captured', queueId:2400 }, '123'), false);
});

test('does not defer older incomplete history after the active match ends', () => {
  const old = { id:'122', queueId:2400, win:null };
  assert.equal(shouldDeferUpload(old, { state:'captured', queueId:2400 }, '123'), false);
  assert.equal(shouldDeferUpload({ ...old, id:'123' }, { state:'waiting', queueId:null }, '123'), false);
});

test('record fingerprints change only when stored match data changes', () => {
  assert.equal(fingerprint({ id:'1', win:true }), fingerprint({ id:'1', win:true }));
  assert.notEqual(fingerprint({ id:'1', win:true }), fingerprint({ id:'1', win:false }));
});

test('credentials and throttling errors remain retryable', () => {
  assert.equal(isPermanentUploadError(401), false);
  assert.equal(isPermanentUploadError(403), false);
  assert.equal(isPermanentUploadError(429), false);
  assert.equal(isPermanentUploadError(400), true);
  assert.equal(isPermanentUploadError(413), true);
});

test('temporary upload failures back off up to fifteen minutes', () => {
  assert.equal(retryDelay(1), 30_000);
  assert.equal(retryDelay(2), 60_000);
  assert.equal(retryDelay(5), 480_000);
  assert.equal(retryDelay(20), 900_000);
});

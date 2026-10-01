import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, PermanentError } from './errors';
import { keys } from './keys';
import { backoffMs } from './queue';
import { sniffFormat } from './sniff';
import { derivedState, nextStage } from './stages';

test('sniff decides format from magic bytes, never the declared type', () => {
  assert.equal(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
  assert.equal(sniffFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'png');
  assert.equal(sniffFormat(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')])), 'heic');
  assert.equal(sniffFormat(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(sniffFormat(Buffer.from([0xff, 0xd8])), null, 'too short');
});

test('stage order and derived fine-grained state', () => {
  assert.equal(nextStage('CONVERT'), 'COMPRESS');
  assert.equal(nextStage('VARIANTS'), null);
  assert.equal(derivedState('PROCESSING', 'COMPRESS', { status: 'QUEUED' }), 'QUEUED_COMPRESSION');
  assert.equal(derivedState('PROCESSING', 'VARIANTS', { status: 'RUNNING' }), 'GENERATING_VARIANTS');
  assert.equal(derivedState('COMPLETE', 'VARIANTS', null), 'COMPLETED');
  assert.equal(derivedState('FAILED', 'COMPRESS', null), 'FAILED');
});

test('errors are classified by origin: only explicit PermanentError is permanent', () => {
  assert.deepEqual(classify(new PermanentError('CORRUPT')), { kind: 'permanent', code: 'CORRUPT' });
  assert.deepEqual(classify(new Error('Input buffer contains unsupported image format')), { kind: 'transient' });
});

test('backoff grows exponentially with jitter and is capped', () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const base = 1000 * 2 ** (attempt - 1);
    const d = backoffMs(attempt);
    assert.ok(d >= base * 0.5 && d <= base, `attempt ${attempt}: ${d}`);
  }
  assert.ok(backoffMs(20) <= 30_000);
});

test('S3 keys are deterministic, stage-first, and contain only ids', () => {
  const u = '11111111-1111-1111-1111-111111111111';
  const i = '22222222-2222-2222-2222-222222222222';
  assert.equal(keys.variant(u, i, 'THUMB'), `variants/${u}/${i}/thumb.jpg`);
  assert.equal(keys.normalized(u, i), keys.normalized(u, i));
  assert.match(keys.original(u, i), /^originals\//);
});

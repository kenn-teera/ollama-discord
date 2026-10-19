import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversations } from '../src/conversations.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('questions in one conversation run one at a time, in order', async () => {
  const c = createConversations();
  const events = [];
  const task = (name, ms) => async () => { events.push(`${name} start`); await sleep(ms); events.push(`${name} end`); return name; };
  const results = await Promise.all([c.run('k', task('a', 60)), c.run('k', task('b', 5)), c.run('k', task('c', 5))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(events, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
});

test('different conversations run in parallel', async () => {
  const c = createConversations();
  const events = [];
  const task = (name) => async () => { events.push(`${name} start`); await sleep(40); events.push(`${name} end`); };
  await Promise.all([c.run('one', task('one')), c.run('two', task('two'))]);
  assert.deepEqual(events.slice(0, 2).sort(), ['one start', 'two start']);
});

test('a failed task does not block the next one, and its error reaches the caller', async () => {
  const c = createConversations();
  const failing = c.run('k', async () => { throw new Error('model down'); });
  const after = c.run('k', async () => 'ok');
  await assert.rejects(failing, /model down/);
  assert.equal(await after, 'ok');
});

test('the queue bookkeeping is cleaned up', async () => {
  const c = createConversations();
  await Promise.all([c.run('a', async () => {}), c.run('a', async () => { throw new Error('x'); }).catch(() => {}), c.run('b', async () => {})]);
  await sleep(5);
  assert.equal(c.pending(), 0);
});

test('overlapping questions keep both exchanges, in order (the race from the review)', async () => {
  const c = createConversations();
  // what answerQuestion does: read a copy, add the question, "generate" slowly, save question + answer
  const ask = (text, ms) => c.run('chan', async () => {
    const epoch = c.epoch('chan');
    const history = [...c.get('chan'), { role: 'user', content: text }];
    await sleep(ms);
    c.save('chan', [...history, { role: 'assistant', content: `re: ${text}` }], epoch, 10);
  });
  await Promise.all([ask('first', 60), ask('second', 5)]); // the second arrives while the first is still generating
  assert.deepEqual(c.get('chan').map((m) => m.content), ['first', 're: first', 'second', 're: second']);
});

test('a failed reply leaves the history exactly as it was (no pop of someone else\'s message)', async () => {
  const c = createConversations();
  c.save('k', [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }], c.epoch('k'), 10);
  const slowFail = c.run('k', async () => { await sleep(30); throw new Error('boom'); });
  const next = c.run('k', async () => { const e = c.epoch('k'); c.save('k', [...c.get('k'), { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }], e, 10); });
  await assert.rejects(slowFail, /boom/);
  await next;
  assert.deepEqual(c.get('k').map((m) => m.content), ['earlier', 'ok', 'q2', 'a2']);
});

test('get returns a copy; save keeps only the newest messages', () => {
  const c = createConversations();
  c.save('k', [1, 2, 3, 4, 5].map((n) => ({ content: n })), c.epoch('k'), 3);
  assert.deepEqual(c.get('k').map((m) => m.content), [3, 4, 5]);
  c.get('k').push({ content: 'tamper' });
  assert.equal(c.get('k').length, 3);
});

test('a --reset while the model is still working discards that reply instead of resurrecting the history', () => {
  const c = createConversations();
  c.save('k', [{ content: 'old' }], c.epoch('k'), 10);
  const epoch = c.epoch('k'); // reply started
  c.reset('k'); // user typed --reset meanwhile
  assert.equal(c.save('k', [{ content: 'old' }, { content: 'late reply' }], epoch, 10), false);
  assert.deepEqual(c.get('k'), []);
  assert.equal(c.save('k', [{ content: 'fresh' }], c.epoch('k'), 10), true); // new conversations work normally
});

test('clearing everything also discards replies that were in flight, and other keys are unaffected by a single reset', () => {
  const c = createConversations();
  const a = c.epoch('a');
  const b = c.epoch('b');
  c.reset('a');
  assert.equal(c.save('b', [{ content: 'b' }], b, 10), true);
  assert.equal(c.save('a', [{ content: 'a' }], a, 10), false);
  const b2 = c.epoch('b');
  c.clear();
  assert.equal(c.save('b', [{ content: 'late' }], b2, 10), false);
  assert.deepEqual(c.get('b'), []);
});

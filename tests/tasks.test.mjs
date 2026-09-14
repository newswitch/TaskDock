import test from 'node:test';
import assert from 'node:assert/strict';
import { changeStatus, mergeTasks, parseDocument, sortTasks, validateTimes } from '../.test-build/tasks.js';
import { formatDuration, fromLocalInputValue, toLocalInputValue } from '../.test-build/time.js';

export const original = { id: 'a', title: '网络策略', status: 'todo', priority: 'medium', note: '', createdAt: '2026-09-01T00:00:00.000Z', startedAt: null, dueAt: null, completedAt: null };
const task = () => parseDocument(JSON.stringify([original])).tasks[0];
test('legacy migration keeps unstarted tasks unstarted and does not invent a waiting timestamp', () => {
  assert.equal(task().startedAt, null);
  assert.equal(parseDocument(JSON.stringify([{ ...original, status: 'waiting' }])).tasks[0].waitingSince, null);
});
test('waiting starts when entering that status, resets on reentry, and preserves the first start', () => {
  const start = '2026-09-01T02:00:00.000Z', wait = '2026-09-02T02:00:00.000Z', resume = '2026-09-03T02:00:00.000Z';
  let t = changeStatus(task(), 'doing', start);
  t = changeStatus(t, 'waiting', wait);
  assert.equal(t.startedAt, start); assert.equal(t.waitingSince, wait);
  assert.equal(changeStatus(t, 'waiting', resume), t);
  t = changeStatus(t, 'doing', resume);
  assert.equal(t.waitingSince, null);
  t = changeStatus(t, 'waiting', resume);
  assert.equal(t.waitingSince, resume); assert.equal(t.history.length, 4);
});
test('completion is stable; reopening preserves completion in status history', () => {
  const at = '2026-09-04T00:00:00.000Z';
  let t = changeStatus(task(), 'done', at);
  assert.equal(changeStatus(t, 'done', '2026-09-05T00:00:00.000Z').completedAt, at);
  t = changeStatus(t, 'todo', '2026-09-05T00:00:00.000Z');
  assert.equal(t.completedAt, null); assert.equal(t.history[0].at, at); assert.equal(t.history[0].to, 'done');
});
test('rejects corrupt entries, duplicates, invalid dates and future schema versions as a whole', () => {
  for (const value of [[null], [original, original], [{...original, createdAt:'bad'}], [{...original,status:'missing'}], {version:99,tasks:[]}]) assert.throws(() => parseDocument(JSON.stringify(value)));
  assert.throws(() => parseDocument('{broken'));
  assert.throws(() => parseDocument(JSON.stringify([{ ...original, createdAt: '2026-02-30T00:00:00Z' }])));
});
test('merge is idempotent and never overwrites a newer local edit or deletion', () => {
  const local = {...task(), title:'local', deletedAt:'2026-09-03T00:00:00.000Z'};
  const extra = {...task(), id:'b'};
  assert.deepEqual(mergeTasks([local], [task(), extra]), [local, extra]);
  assert.deepEqual(mergeTasks([local, extra], [task(), extra]), [local, extra]);
});
test('history sorting retains all records beyond twenty or fifty', () => {
  const records = Array.from({length:75}, (_, i) => ({...task(),id:String(i),priority:i === 74 ? 'high':'medium'}));
  const sorted = sortTasks(records);
  assert.equal(sorted.length, 75); assert.equal(sorted[0].id, '74'); assert.equal(records[0].id, '0');
});
test('validates actual start, expected completion and completed-task edits', () => {
  const start = '2026-09-02T00:00:00.000Z', before = '2026-09-01T00:00:00.000Z', after = '2026-09-03T00:00:00.000Z';
  assert.ok(validateTimes(start, null, before)); assert.ok(validateTimes(start, before, after)); assert.ok(validateTimes(start, null, after, before));
  assert.equal(validateTimes(null, before, after), null); assert.equal(validateTimes(start, after, after), null);
});
test('local date input round trips without timezone drift and rejects normalized invalid dates', () => {
  const iso = '2026-09-14T04:30:00.000Z';
  assert.equal(fromLocalInputValue(toLocalInputValue(iso)), iso);
  assert.equal(fromLocalInputValue('2026-02-30T12:00'), null);
  assert.equal(formatDuration('2026-09-01T00:00:00Z', new Date('2026-09-03T03:05:00Z')), '2天3小时');
});

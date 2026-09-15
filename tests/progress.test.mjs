import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, changeStatus, taskSummary, mergeTasks } from '../.test-build/tasks.js';
import { TaskRepository, browserBackend } from '../.test-build/storage.js';

const original = { id:'progress-task', title:'招聘', status:'todo', priority:'medium', note:'长期备注', createdAt:'2026-09-01T00:00:00.000Z' };
const goal = { title:'找到合适的人', current:1, target:2, unit:'人' };
const entries = [
  { id:'a', at:'2026-09-02T00:00:00.000Z', text:'确认 1 人合适' },
  { id:'b', at:'2026-09-03T00:00:00.000Z', text:'今天收到 3 份简历' },
];
const document = task => JSON.stringify({version:3,tasks:[task]});

test('legacy arrays and version 2 tasks gain empty optional progress without changing notes or status', () => {
  for (const raw of [JSON.stringify([original]), JSON.stringify({version:2,tasks:[original]})]) {
    const parsed = parseDocument(raw);
    assert.equal(parsed.version,3);
    assert.equal(parsed.tasks[0].goal,null);
    assert.deepEqual(parsed.tasks[0].progress,[]);
    assert.equal(taskSummary(parsed.tasks[0]),'长期备注');
    assert.equal(parsed.tasks[0].status,'todo');
  }
});

test('latest progress replaces only the summary and neither updates the count nor completes the task', () => {
  const task = parseDocument(document({...original,goal,progress:[...entries].reverse()})).tasks[0];
  assert.equal(taskSummary(task),entries[1].text);
  assert.equal(task.note,original.note);
  assert.equal(task.goal.current,1);
  const reached = parseDocument(document({...task,goal:{...goal,current:3}})).tasks[0];
  assert.equal(reached.status,'todo');
  assert.equal(reached.completedAt,null);
  const done = changeStatus(task,'done','2026-09-04T00:00:00.000Z');
  const reopened = changeStatus(done,'todo','2026-09-05T00:00:00.000Z');
  assert.deepEqual(reopened.progress,entries);
  assert.deepEqual(reopened.goal,goal);
});

test('reject malformed counts, blank targets, broken records and future versions rather than dropping progress', () => {
  for (const invalid of [{...goal,current:-1},{...goal,target:0},{...goal,current:1.5},{...goal,target:'2'},{...goal,title:' '},{...goal,unit:''}]) {
    assert.throws(()=>parseDocument(document({...original,goal:invalid})));
  }
  for (const progress of [[entries[0],entries[0]],[{...entries[0],text:' '}],[{...entries[0],at:'invalid'}]]) {
    assert.throws(()=>parseDocument(document({...original,progress})));
  }
  assert.throws(()=>parseDocument(JSON.stringify({version:4,tasks:[]})));
});

test('progress survives save, reload, export/import, merge and recoverable deletion', async () => {
  const values = new Map();
  const storage = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const repo = new TaskRepository(browserBackend(storage),()=>null);
  await repo.load();
  const task = parseDocument(document({...original,goal,progress:entries})).tasks[0];
  await repo.save([task]);
  const reload = new TaskRepository(browserBackend(storage),()=>null);
  assert.deepEqual((await reload.load()).tasks,[task]);
  const imported = parseDocument(document(task)).tasks;
  const deleted = {...task,deletedAt:'2026-09-04T00:00:00.000Z'};
  assert.deepEqual(mergeTasks([deleted],imported),[deleted]);
  await reload.save([deleted]);
  const backup = await reload.backend.readBackup(1);
  assert.deepEqual(parseDocument(backup).tasks,[task]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, sortTasks, reorderTasks } from '../.test-build/tasks.js';
import { TaskRepository, browserBackend } from '../.test-build/storage.js';

const at = '2026-09-16T00:00:00.000Z';
const tasks = parseDocument(JSON.stringify({version:3,tasks:['a','b','c','d'].map((id,index)=>({
  id,title:id,note:'',status:index===3?'done':'todo',priority:index===0?'high':'medium',createdAt:at,completedAt:index===3?at:null,
}))})).tasks;
const ids = list => sortTasks(list.filter(t=>t.status!=='done')).map(t=>t.id);

test('manual order overrides priority and preserves unrelated task data',()=>{
  const result = reorderTasks(tasks,'c','a',false,at);
  assert.deepEqual(ids(result),['c','a','b']);
  assert.equal(result[3],tasks[3]);
  assert.equal(result[0].priority,'high');
  assert.deepEqual(ids(reorderTasks(result,'c','b',true,at)),['a','b','c']);
  assert.deepEqual(ids(tasks),['a','b','c']);
});
test('filtered target movement keeps hidden tasks and no-op moves do not save',()=>{
  assert.deepEqual(ids(reorderTasks(tasks,'a','c',true,at)),['b','c','a']);
  for(const [source,target,after] of [['a','a',false],['b','a',true],['d','a',false],['a','missing',true]]) {
    assert.equal(reorderTasks(tasks,source,target,after,at),tasks);
  }
});
test('order survives save and reload; invalid order is rejected',async()=>{
  const values = new Map();
  const backend = browserBackend({getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)});
  const repo = new TaskRepository(backend,()=>null);
  await repo.load();
  await repo.save(reorderTasks(tasks,'c','a',false,at));
  assert.deepEqual(ids((await new TaskRepository(backend,()=>null).load()).tasks),['c','a','b']);
  for (const sortOrder of [-1,0.5,'1']) assert.throws(()=>parseDocument(JSON.stringify({version:3,tasks:[{...tasks[0],sortOrder}]})));
});

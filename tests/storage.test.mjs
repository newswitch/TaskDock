import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRepository, browserBackend, STORAGE_KEY, LEGACY_KEY } from '../.test-build/storage.js';
import { parseDocument } from '../.test-build/tasks.js';

const original = { id:'a', title:'task', status:'todo', priority:'medium', note:'', createdAt:'2026-09-01T00:00:00Z', startedAt:null, dueAt:null, completedAt:null };
function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value), values };
}
function repo(storage) { return new TaskRepository(browserBackend(storage), () => storage.getItem(LEGACY_KEY)); }
test('a corrupt document blocks loading without overwriting original bytes', async () => {
  const storage = memory({[STORAGE_KEY]:'{broken'});
  await assert.rejects(repo(storage).load()); assert.equal(storage.getItem(STORAGE_KEY), '{broken'); assert.equal(storage.values.size, 1);
});
test('invalid legacy data is retained and does not create a new document', async () => {
  const storage = memory({[LEGACY_KEY]:'[null]'});
  await assert.rejects(repo(storage).load()); assert.equal(storage.getItem(LEGACY_KEY),'[null]'); assert.equal(storage.getItem(STORAGE_KEY),null);
});
test('concurrent initial loads migrate exactly once while retaining the legacy key', async () => {
  const legacy = JSON.stringify([original]), storage = memory({[LEGACY_KEY]:legacy});
  const repository = repo(storage);
  const [a,b] = await Promise.all([repository.load(),repository.load()]);
  assert.equal(a.tasks.length,1); assert.deepEqual(a,b); assert.equal(storage.getItem(LEGACY_KEY),legacy);
  assert.equal(parseDocument(storage.getItem(STORAGE_KEY)).tasks.length,1);
});
test('empty startup never creates or saves a document', async () => {
  const storage = memory(); assert.deepEqual((await repo(storage).load()).tasks,[]); assert.equal(storage.values.size,0);
});
test('write failure rejects the edit and preserves the durable document', async () => {
  const storage = memory({[LEGACY_KEY]:JSON.stringify([original])});
  const repository = repo(storage), {tasks} = await repository.load(), saved = storage.getItem(STORAGE_KEY);
  storage.setItem = () => {throw new Error('disk full');};
  await assert.rejects(repository.save([{...tasks[0],title:'changed'}]), /disk full/);
  assert.equal(storage.getItem(STORAGE_KEY), saved);
});
test('another window cannot silently overwrite changes; reload then save succeeds', async () => {
  const storage = memory({[LEGACY_KEY]:JSON.stringify([original])});
  const a = repo(storage), b = repo(storage);
  const {tasks} = await a.load(); await b.load();
  await a.save([{...tasks[0], title:'first window'}]);
  await assert.rejects(b.save(tasks), /另一窗口/);
  const refreshed = await b.load(); assert.equal(refreshed.tasks[0].title,'first window'); await b.save(refreshed.tasks);
});
test('recovery from a valid previous version preserves the backup when current data is corrupt', async () => {
  const backup = JSON.stringify({version:2,tasks:parseDocument(JSON.stringify([original])).tasks});
  const storage = memory({[STORAGE_KEY]:'broken',[`${STORAGE_KEY}.backup`]:backup});
  const repository = repo(storage); await assert.rejects(repository.load());
  const restored = parseDocument(await repository.backend.readBackup(1));
  await repository.save(restored.tasks);
  assert.equal(storage.getItem(`${STORAGE_KEY}.backup`),backup); assert.equal((await repository.load()).tasks.length,1);
});

test('saving unchanged tasks keeps the previous recoverable version', async () => {
  const storage = memory({[LEGACY_KEY]:JSON.stringify([original])});
  const repository = repo(storage), {tasks} = await repository.load();
  const first = storage.getItem(STORAGE_KEY);
  const edited = [{...tasks[0], title:'edited'}];
  await repository.save(edited);
  assert.equal(storage.getItem(`${STORAGE_KEY}.backup`), first);
  await repository.save(edited);
  assert.equal(storage.getItem(`${STORAGE_KEY}.backup`), first);
});

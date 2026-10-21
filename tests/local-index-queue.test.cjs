'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { idFor } = require('../src/model.cjs');

test('persisted HTTP access pause still drains reliable local work and preserves unresolved jobs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-local-queue-'));
  const dataDir = path.join(root, 'data');
  const filename = path.join(root, 'subjects.sqlite');
  const source = path.join(root, 'source');
  const album = path.join(source, 'Reliable Chronicle');
  fs.mkdirSync(album, { recursive: true });
  const d = new DatabaseSync(filename);
  d.exec(`
    CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,nsfw INTEGER,date TEXT,summary TEXT,infobox TEXT,collection_json TEXT,aliases_json TEXT,raw_json TEXT);
    CREATE TABLE name_keys(subject_id INTEGER,type INTEGER,key TEXT,name TEXT,kind TEXT);
    CREATE INDEX name_keys_type_key ON name_keys(type,key,subject_id);
    CREATE TABLE entities(kind TEXT,id INTEGER,name TEXT,name_cn TEXT,summary TEXT,infobox TEXT,aliases_json TEXT,raw_json TEXT);
    CREATE TABLE entity_keys(kind TEXT,id INTEGER,key TEXT,name TEXT);
    CREATE INDEX entity_keys_kind_key ON entity_keys(kind,key,id);
    CREATE TABLE links(source_kind TEXT,source_id INTEGER,target_kind TEXT,target_id INTEGER,relation_type TEXT);
    CREATE INDEX links_source ON links(source_kind,source_id,target_kind,target_id);
    CREATE INDEX links_target ON links(target_kind,target_id,source_kind,source_id);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('source','{"dataVersion":"fixture"}');
    CREATE VIRTUAL TABLE names_fts USING fts5(key,subject_id UNINDEXED,type UNINDEXED,tokenize='trigram');
    CREATE VIRTUAL TABLE entity_names_fts USING fts5(key,kind UNINDEXED,id UNINDEXED,tokenize='trigram');
    INSERT INTO subjects VALUES(1,4,'Reliable Chronicle','',0,'2000-01-01','offline summary','[]','{"collect":100}','[]','{}');
    INSERT INTO name_keys VALUES(1,4,'reliablechronicle','Reliable Chronicle','name');
    INSERT INTO names_fts SELECT key,subject_id,type FROM name_keys;
  `);
  d.close();
  const worker = new Worker(
    `
    const {workerData,parentPort}=require('node:worker_threads');
    global.fetch=async()=>{ parentPort.postMessage({event:'fixtureHTTP',data:{}});
      return {status:403,ok:false,headers:new Headers(),json:async()=>({})}; };
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        localIndexPath: filename,
        token: '',
        watch: false,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      }
    }
  );
  let sequence = 0;
  const pending = new Map();
  const events = [];
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.event) events.push(m);
      const p = pending.get(m.request);
      if (p) {
        pending.delete(m.request);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    });
  });
  function call(method, args = {}) {
    const request = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('RPC timeout ' + method));
      }, 12000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  }
  t.after(async () => {
    try {
      await call('shutdown');
    } finally {
      await worker.terminate();
      assert.ok(root.startsWith(path.join(os.tmpdir(), 'acg-local-queue-')));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  // First create a paused durable HTTP task, before introducing the local work.
  const empty = path.join(root, 'NetworkOnly');
  fs.mkdirSync(empty);
  const paused = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pause timeout')), 12000);
    const check = (m) => {
      if (m.event === 'online' && !m.data.active && m.data.paused === 'access') {
        clearTimeout(timer);
        worker.off('message', check);
        resolve();
      }
    };
    worker.on('message', check);
  });
  await call('scan', { path: empty, onlineMatch: true, subjectTypes: [4] });
  await paused;
  assert.ok(events.some((e) => e.event === 'fixtureHTTP'));
  const drained = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('local drain timeout')), 12000);
    const check = async (m) => {
      if (m.event === 'online' && !m.data.active && m.data.paused === 'access') {
        try {
          // Identity is useful while online details remain pending; saving it
          // must not count the unfinished detail/cover task as completed.
          const node = await call('get', { id: idFor(album) });
          if (node?.subject_id !== 1) return;
          clearTimeout(timer);
          worker.off('message', check);
          resolve();
        } catch (error) {
          clearTimeout(timer);
          worker.off('message', check);
          reject(error);
        }
      }
    };
    worker.on('message', check);
  });
  await call('scan', { path: source, onlineMatch: true, subjectTypes: [4] });
  await drained;
  assert.equal((await call('get', { id: idFor(album) })).subject_id, 1);
  const status = await call('syncStatus');
  assert.equal(status.paused, 'access');
  assert.ok(status.pending >= 1);
  // No repeated online calls or rescheduling loop while paused.
  assert.equal(events.filter((e) => e.event === 'fixtureHTTP').length, 1);
});

'use strict';
const path = require('node:path');
const { idFor: defaultIdFor } = require('./model.cjs');
const { sortKey: defaultSortKey } = require('./natural-sort.cjs');

const fail = (code, message) => Object.assign(new Error(message), { code });
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep)
  );
};
const equivalent = (a, b) => a.toLowerCase() === b.toLowerCase();
/** Explicit user-authorized rename only. No filesystem writes or name inference.
 * prepare() yields with no write transaction open. Caller reserves the affected
 * root, invalidates old async jobs, then executes FS before commit(). commit()
 * owns one synchronous atomic transaction, including its durable commit receipt.
 */
function createRenameIdentity(
  db,
  { idFor = defaultIdFor, sortKey = defaultSortKey, pendingStampFor } = {}
) {
  const has = (name) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(nodes)')
      .all()
      .map((column) => column.name)
  );
  if (!columns.has('root') || !columns.has('path')) throw new TypeError('nodes schema is required');
  db.exec(`CREATE TABLE IF NOT EXISTS rename_commits(
    op_id TEXT PRIMARY KEY,old_path TEXT NOT NULL,new_path TEXT NOT NULL,result TEXT NOT NULL,committed_at REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS nodes_rename_parent ON nodes(parent,id);
  CREATE TEMP TABLE IF NOT EXISTS rename_identity_map(
    seq INTEGER PRIMARY KEY,op TEXT NOT NULL,row_id INTEGER NOT NULL,old_id TEXT NOT NULL,new_id TEXT NOT NULL,
    old_path TEXT NOT NULL,new_path TEXT NOT NULL,old_parent TEXT,old_root TEXT NOT NULL,
    old_kind TEXT NOT NULL,old_depth INTEGER NOT NULL,new_name TEXT NOT NULL,new_sortkey TEXT NOT NULL,
    scanned INTEGER NOT NULL DEFAULT 0,UNIQUE(op,old_id),UNIQUE(op,new_id),UNIQUE(op,row_id)
  );
  CREATE INDEX IF NOT EXISTS rename_identity_scan ON rename_identity_map(op,scanned,seq);
  CREATE TEMP TABLE IF NOT EXISTS rename_identity_backlog(
    op TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,stamp TEXT NOT NULL,PRIMARY KEY(op,id)
  );`);
  for (const column of ['cover', 'local_newest'])
    if (columns.has(column))
      db.exec(`CREATE INDEX IF NOT EXISTS nodes_scan_${column} ON nodes(${column})`);
  const get = db.prepare('SELECT rowid AS node_rowid,* FROM nodes WHERE id=?');
  const children = db.prepare(
    'SELECT rowid AS node_rowid,* FROM nodes WHERE parent=? AND id>? ORDER BY id LIMIT 128'
  );
  const mapRow = db.prepare(`INSERT INTO rename_identity_map
    (op,row_id,old_id,new_id,old_path,new_path,old_parent,old_root,old_kind,old_depth,new_name,new_sortkey)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const unscanned = db.prepare(
    'SELECT * FROM rename_identity_map WHERE op=? AND scanned=0 ORDER BY seq LIMIT 128'
  );
  const conflict = db.prepare(
    'SELECT rowid AS node_rowid FROM nodes WHERE id=? OR path=? COLLATE NOCASE'
  );
  const commitReceipt = db.prepare('SELECT * FROM rename_commits WHERE op_id=?');
  const frontier = has('match_frontier')
    ? db.prepare('SELECT after_id FROM match_frontier WHERE root=?')
    : null;
  const pending = has('match_pending');
  const manualTitles = has('manual_title_keys');
  const media = has('media');
  const fts = has('search_index');
  const rootsPolicy = has('root_match_policy');
  const temps = new Set(
    db
      .prepare("SELECT name FROM sqlite_temp_master WHERE type='table'")
      .all()
      .map((row) => row.name)
  );
  const optionalIdTables = [
    ...(media ? [['media', 'id']] : []),
    ...(manualTitles ? [['manual_title_keys', 'node_id']] : []),
    ...(pending ? [['match_pending', 'id']] : []),
    ...['match_batch_done', 'match_deferred']
      .filter((name) => temps.has(name))
      .map((name) => [name, 'id'])
  ];
  let activePlan = null;
  const issued = new WeakSet();
  function clear(op) {
    db.prepare('DELETE FROM rename_identity_map WHERE op=?').run(op);
    db.prepare('DELETE FROM rename_identity_backlog WHERE op=?').run(op);
  }
  function validateRow(row, source, newPath, op) {
    if (
      row.id !== idFor(row.path) ||
      row.root !== source.root ||
      (row.id !== source.id && !within(source.path, row.path))
    )
      throw fail('RENAME_STRUCTURE', '源子树的路径或归属关系无效。');
    const destination =
      row.id === source.id ? newPath : path.join(newPath, path.relative(source.path, row.path));
    const newId = idFor(destination);
    for (const other of conflict.all(newId, destination))
      if (other.node_rowid !== row.node_rowid)
        throw fail('RENAME_CONFLICT', '目标路径已有其他索引条目。');
    if (newId !== row.id) {
      for (const [table, key] of optionalIdTables)
        if (db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(newId))
          throw fail('RENAME_CONFLICT', '目标编号已有其他关联数据。');
    }
    const name = row.id === source.id ? path.basename(newPath) : row.name;
    mapRow.run(
      op,
      row.node_rowid,
      row.id,
      newId,
      row.path,
      destination,
      row.parent,
      row.root,
      row.kind,
      row.depth,
      name,
      row.id === source.id ? sortKey(name) : row.sortkey
    );
  }
  function assertPlan(plan) {
    if (!issued.has(plan) || activePlan !== plan) throw fail('RENAME_PLAN', '重命名映射已过期。');
    if (commitReceipt.get(plan.opId)) throw fail('RENAME_COMMITTED', '操作已经提交。');
    const current = get.get(plan.oldId);
    if (
      !current ||
      current.path !== plan.oldPath ||
      current.root !== plan.oldRoot ||
      current.missing
    )
      throw fail('RENAME_CHANGED', '准备期间源条目已变化。');
    if ((frontier?.get(plan.oldRoot)?.after_id ?? null) !== plan.frontierAfter)
      throw fail('RENAME_CHANGED', '准备期间匹配发现游标已变化。');
    const invalid = db
      .prepare(
        `SELECT 1 FROM rename_identity_map m LEFT JOIN nodes n ON n.rowid=m.row_id
      WHERE m.op=? AND (n.id IS NOT m.old_id OR n.path IS NOT m.old_path OR n.parent IS NOT m.old_parent
      OR n.root IS NOT m.old_root OR n.kind IS NOT m.old_kind OR n.depth IS NOT m.old_depth) LIMIT 1`
      )
      .get(plan.opId);
    if (invalid) throw fail('RENAME_CHANGED', '准备期间子树结构已变化。');
    const added = db
      .prepare(
        `SELECT 1 FROM rename_identity_map m JOIN nodes n ON n.parent=m.old_id
      WHERE m.op=? AND NOT EXISTS(SELECT 1 FROM rename_identity_map child WHERE child.op=m.op AND child.row_id=n.rowid) LIMIT 1`
      )
      .get(plan.opId);
    if (added) throw fail('RENAME_CHANGED', '准备期间子树加入了新条目。');
    if (
      plan.rootRenamed &&
      db.prepare('SELECT COUNT(*) total FROM nodes WHERE root=?').get(plan.oldRoot).total !==
        plan.count
    )
      throw fail('RENAME_STRUCTURE', '分类包含无法迁移的孤立节点。');
    const collisions = db
      .prepare(
        `SELECT 1 FROM rename_identity_map m JOIN nodes n
      ON n.id=m.new_id OR n.path=m.new_path COLLATE NOCASE
      WHERE m.op=? AND n.rowid<>m.row_id LIMIT 1`
      )
      .get(plan.opId);
    if (collisions) throw fail('RENAME_CONFLICT', '目标索引在准备后被占用。');
    for (const [table, key] of optionalIdTables) {
      if (
        db
          .prepare(
            `SELECT 1 FROM rename_identity_map m JOIN ${table} t ON t.${key}=m.new_id
        WHERE m.op=? AND m.old_id<>m.new_id LIMIT 1`
          )
          .get(plan.opId)
      )
        throw fail('RENAME_CONFLICT', '目标关联在准备后被占用。');
    }
    if (
      rootsPolicy &&
      plan.rootRenamed &&
      plan.oldRoot !== plan.root &&
      db.prepare('SELECT 1 FROM root_match_policy WHERE root=?').get(plan.root)
    )
      throw fail('RENAME_CONFLICT', '目标分类策略已存在。');
    if (
      has('root_removals') &&
      db.prepare('SELECT 1 FROM root_removals WHERE root=?').get(plan.oldRoot)
    )
      throw fail('RENAME_BUSY', '分类正在移除。');
  }
  const service = {
    async prepare({ id, newPath, operationId }, checkpoint = async () => {}) {
      if (db.isTransaction) throw fail('RENAME_TRANSACTION', '重命名准备不能跨越外部事务。');
      if (activePlan) throw fail('RENAME_BUSY', '已有重命名映射正在准备或提交。');
      if (
        typeof operationId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/u.test(operationId) ||
        typeof newPath !== 'string' ||
        !path.isAbsolute(newPath)
      )
        throw fail('RENAME_PLAN', '重命名路径或操作编号无效。');
      if (commitReceipt.get(operationId)) throw fail('RENAME_COMMITTED', '操作编号已经提交。');
      const source = get.get(id);
      if (!source || source.missing) throw fail('RENAME_SOURCE', '源条目不存在或已离线。');
      newPath = path.resolve(newPath);
      if (!equivalent(path.dirname(source.path), path.dirname(newPath)))
        throw fail('RENAME_PATH', '此操作只允许同目录重命名。');
      const rootNode = get.get(source.root);
      if (
        !rootNode ||
        rootNode.parent !== null ||
        rootNode.root !== rootNode.id ||
        rootNode.kind !== 'folder' ||
        rootNode.missing ||
        (source.parent === null && (source.id !== source.root || source.depth !== 0)) ||
        (source.parent !== null && !within(rootNode.path, source.path))
      )
        throw fail('RENAME_STRUCTURE', '源分类结构无效。');
      const plan = {
        opId: operationId,
        oldId: id,
        id: idFor(newPath),
        oldRoot: source.root,
        root: source.parent === null ? idFor(newPath) : source.root,
        oldPath: source.path,
        path: newPath,
        count: 0,
        rootRenamed: source.parent === null,
        caseOnly: source.path !== newPath && equivalent(source.path, newPath),
        noOp: source.path === newPath,
        frontierAfter: frontier?.get(source.root)?.after_id ?? null
      };
      activePlan = plan;
      try {
        clear(operationId);
        validateRow(source, source, newPath, operationId);
        while (true) {
          const page = unscanned.all(operationId);
          if (!page.length) break;
          for (const row of page) {
            if (row.old_kind === 'folder') {
              let after = '';
              while (true) {
                const childPage = children.all(row.old_id, after);
                if (!childPage.length) break;
                for (const child of childPage) {
                  if (
                    !equivalent(path.dirname(child.path), row.old_path) ||
                    child.depth !== row.old_depth + 1
                  )
                    throw fail('RENAME_STRUCTURE', '子树父子路径关系无效。');
                  validateRow(child, source, newPath, operationId);
                }
                after = childPage.at(-1).id;
                await checkpoint();
              }
            }
            db.prepare('UPDATE rename_identity_map SET scanned=1 WHERE seq=?').run(row.seq);
          }
          await checkpoint();
        }
        plan.count = db
          .prepare('SELECT COUNT(*) total FROM rename_identity_map WHERE op=?')
          .get(operationId).total;
        if (plan.frontierAfter !== null) {
          if (typeof pendingStampFor !== 'function' || !pending)
            throw fail('RENAME_FRONTIER', '迁移发现游标需要提供待匹配资格和戳回调。');
          let after = plan.frontierAfter;
          while (true) {
            const page = db
              .prepare(
                "SELECT * FROM nodes WHERE root=? AND missing=0 AND kind='folder' AND id>? ORDER BY id LIMIT 128"
              )
              .all(source.root, after);
            if (!page.length) break;
            for (const node of page) {
              const stamp = pendingStampFor(node);
              if (stamp !== null && stamp !== undefined && stamp !== false) {
                if (typeof stamp !== 'string')
                  throw new TypeError('pendingStampFor must return a stamp string or null');
                db.prepare('INSERT INTO rename_identity_backlog VALUES(?,?,?,?)').run(
                  operationId,
                  node.id,
                  node.root,
                  stamp
                );
              }
            }
            after = page.at(-1).id;
            await checkpoint();
          }
        }
        issued.add(plan);
        assertPlan(plan);
        return Object.freeze(plan);
      } catch (error) {
        clear(operationId);
        activePlan = null;
        throw error;
      }
    },
    commit(plan, { started = Date.now() } = {}) {
      if (db.isTransaction) throw fail('RENAME_TRANSACTION', '重命名提交不能加入外部事务。');
      assertPlan(plan);
      if (plan.noOp) {
        service.dispose(plan);
        return {
          renamed: false,
          oldId: plan.oldId,
          id: plan.id,
          oldRoot: plan.oldRoot,
          root: plan.root,
          oldPath: plan.oldPath,
          path: plan.path,
          node: get.get(plan.id),
          count: plan.count,
          caseOnly: false
        };
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        assertPlan(plan);
        const op = plan.opId;
        if (fts)
          db.prepare(
            'DELETE FROM search_index WHERE rowid IN (SELECT row_id FROM rename_identity_map WHERE op=?)'
          ).run(op);
        // All references resolve against the fixed map, never against already
        // changed IDs. No user-authored columns or metadata JSON are rewritten.
        for (const column of ['parent', 'cover', 'local_newest'].filter((key) => columns.has(key)))
          db.prepare(
            `UPDATE nodes SET ${column}=(SELECT new_id FROM rename_identity_map m WHERE m.op=? AND m.old_id=nodes.${column})
            WHERE ${column} IN (SELECT old_id FROM rename_identity_map WHERE op=? AND old_id<>new_id)`
          ).run(op, op);
        db.prepare(
          `UPDATE nodes SET
          id=(SELECT new_id FROM rename_identity_map WHERE op=? AND row_id=nodes.rowid),
          path=(SELECT new_path FROM rename_identity_map WHERE op=? AND row_id=nodes.rowid),
          name=(SELECT new_name FROM rename_identity_map WHERE op=? AND row_id=nodes.rowid),
          sortkey=(SELECT new_sortkey FROM rename_identity_map WHERE op=? AND row_id=nodes.rowid),
          root=?,indexed=? WHERE rowid IN(SELECT row_id FROM rename_identity_map WHERE op=?)`
        ).run(op, op, op, op, plan.root, started, op);
        for (const [table, key] of optionalIdTables)
          db.prepare(
            `UPDATE ${table} SET ${key}=(SELECT new_id FROM rename_identity_map m WHERE m.op=? AND m.old_id=${table}.${key})
            WHERE ${key} IN(SELECT old_id FROM rename_identity_map WHERE op=? AND old_id<>new_id)`
          ).run(op, op);
        if (pending && plan.oldRoot !== plan.root)
          db.prepare('UPDATE match_pending SET root=? WHERE root=?').run(plan.root, plan.oldRoot);
        if (plan.frontierAfter !== null) {
          db.prepare(
            `INSERT OR IGNORE INTO match_pending(id,root,stamp)
            SELECT COALESCE(m.new_id,b.id),?,b.stamp FROM rename_identity_backlog b
            LEFT JOIN rename_identity_map m ON m.op=b.op AND m.old_id=b.id WHERE b.op=?`
          ).run(plan.root, op);
          db.prepare('DELETE FROM match_frontier WHERE root=?').run(plan.oldRoot);
        }
        if (rootsPolicy && plan.rootRenamed && plan.oldRoot !== plan.root)
          db.prepare('UPDATE root_match_policy SET root=? WHERE root=?').run(
            plan.root,
            plan.oldRoot
          );
        if (fts)
          db.prepare(
            `INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes
          WHERE missing=0 AND rowid IN(SELECT row_id FROM rename_identity_map WHERE op=?)`
          ).run(op);
        const result = {
          renamed: true,
          oldId: plan.oldId,
          id: plan.id,
          oldRoot: plan.oldRoot,
          root: plan.root,
          oldPath: plan.oldPath,
          path: plan.path,
          node: get.get(plan.id),
          count: plan.count,
          caseOnly: plan.caseOnly
        };
        db.prepare('INSERT INTO rename_commits VALUES(?,?,?,?,?)').run(
          op,
          plan.oldPath,
          plan.path,
          JSON.stringify(result),
          started
        );
        clear(plan.opId);
        db.exec('COMMIT');
        issued.delete(plan);
        activePlan = null;
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    isCommitted(operationId) {
      return !!commitReceipt.get(operationId);
    },
    committed(operationId) {
      const row = commitReceipt.get(operationId);
      return row ? JSON.parse(row.result) : null;
    },
    recover({ fsRename }) {
      return fsRename.recover({ isCommitted: (operationId) => service.isCommitted(operationId) });
    },
    dispose(plan) {
      if (activePlan !== plan) return;
      issued.delete(plan);
      clear(plan.opId);
      activePlan = null;
    }
  };
  service.plan = service.prepare;
  service.apply = service.commit;
  return service;
}
module.exports = { createRenameIdentity };

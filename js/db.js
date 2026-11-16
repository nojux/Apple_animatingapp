// Tiny IndexedDB wrapper. Stores: "projects" (full data) and "meta" (list info + thumbnail).
// The unsaved animation (before its first Save) lives in "projects" under DRAFT_ID and has no
// meta row, so it never shows up in the projects list.
export const DRAFT_ID = '__draft__';

let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('inkframe', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('projects', { keyPath: 'id' });
        r.result.createObjectStore('meta', { keyPath: 'id' });
      };
      r.onsuccess = () => {
        const d = r.result;
        // Safari can drop the connection while the app is in the background, and another tab may upgrade.
        d.onclose = () => { dbp = null; };
        d.onversionchange = () => { d.close(); dbp = null; };
        res(d);
      };
      r.onerror = () => { dbp = null; rej(r.error); };
      r.onblocked = () => { dbp = null; rej(new Error('Storage is busy in another window. Close other Inkframe windows and try again.')); };
    });
  }
  return dbp;
}

// Run fn inside one transaction. Resolves when it has committed, rejects if it errors OR aborts
// (a full disk aborts the transaction, which used to leave the save hanging forever).
function run(stores, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    const out = fn(Object.fromEntries(stores.map((n) => [n, t.objectStore(n)])));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new DOMException('Saving was interrupted', 'AbortError'));
  }));
}
// Retry once with a fresh connection when Safari has silently closed the old one.
async function tx(stores, mode, fn) {
  try { return await run(stores, mode, fn); } catch (e) {
    if (e && (e.name === 'InvalidStateError' || e.name === 'UnknownError' || /connection/i.test(e.message || ''))) {
      dbp = null;
      return run(stores, mode, fn);
    }
    throw e;
  }
}

// Project data and its list entry are written together, so the list never points at missing data.
// alsoDelete: an id to remove in the same step (the draft, after its first save).
export const saveProject = (p, meta, alsoDelete) => tx(['projects', 'meta'], 'readwrite', (s) => {
  s.projects.put(p);
  s.meta.put(meta);
  if (alsoDelete && alsoDelete !== p.id) { s.projects.delete(alsoDelete); s.meta.delete(alsoDelete); }
});
export const saveDraft = (p) => tx(['projects'], 'readwrite', (s) => { s.projects.put({ ...p, id: DRAFT_ID }); });
export const deleteDraft = () => tx(['projects'], 'readwrite', (s) => { s.projects.delete(DRAFT_ID); });
export const loadProject = (id) => tx(['projects'], 'readonly', (s) => s.projects.get(id));
export const listMeta = () => tx(['meta'], 'readonly', (s) => s.meta.getAll())
  .then((a) => (a || []).filter((m) => m.id !== DRAFT_ID).sort((x, y) => y.updated - x.updated));
export const deleteProject = (id) => tx(['projects', 'meta'], 'readwrite', (s) => {
  s.projects.delete(id);
  s.meta.delete(id);
});

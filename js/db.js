// Tiny IndexedDB wrapper. Stores: "projects" (full data) and "meta" (list info + thumbnail).
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('inkframe', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('projects', { keyPath: 'id' });
        r.result.createObjectStore('meta', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
function tx(store, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  }));
}
export const saveProject = (p, meta) => Promise.all([
  tx('projects', 'readwrite', (s) => s.put(p)),
  tx('meta', 'readwrite', (s) => s.put(meta)),
]);
export const loadProject = (id) => tx('projects', 'readonly', (s) => s.get(id));
export const listMeta = () => tx('meta', 'readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => y.updated - x.updated));
export const deleteProject = (id) => Promise.all([
  tx('projects', 'readwrite', (s) => s.delete(id)),
  tx('meta', 'readwrite', (s) => s.delete(id)),
]);

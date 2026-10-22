const DB_NAME = 'vm-offline';
const STORE = 'operations';

export interface QueuedOperation {
  client_op_id: string;
  type: 'task_results' | 'labor' | 'comment' | 'transition' | 'request' | 'downtime' | 'completion_signature';
  record_id: string | null;
  base_version: number | null;
  payload: Record<string, unknown>;
  queued_at: string;
  status: 'pending' | 'conflict' | 'rejected';
  server_error?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'client_op_id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(op: Omit<QueuedOperation, 'queued_at' | 'status'>): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...op, queued_at: new Date().toISOString(), status: 'pending' } satisfies QueuedOperation);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listQueue(): Promise<QueuedOperation[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as QueuedOperation[]).sort((a, b) => a.queued_at.localeCompare(b.queued_at)));
    req.onerror = () => reject(req.error);
  });
}

export async function clearQueue(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function recordResult(clientOpId: string, status: QueuedOperation['status'], server_error?: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get = store.get(clientOpId);
    get.onsuccess = () => {
      const row = get.result as QueuedOperation | undefined;
      if (!row) return;
      if (status === 'pending') store.delete(clientOpId);
      else store.put({ ...row, status, server_error });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

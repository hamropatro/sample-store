// Durable order records. A JSON file is enough for a sample; a real shop needs a
// transactional database, since this store is single-process and rewrites the whole file.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function openOrderStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'orders.json');
  let orders;
  try { orders = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read .data/orders.json. Restore it before starting the store.'); orders = []; }
  const records = new Map(orders.map(order => [order.id, order]));
  let secret;
  const secretPath = join(directory, 'session-secret');
  try { secret = await readFile(secretPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; secret = randomBytes(32).toString('hex'); await writeFile(secretPath, secret, { mode: 0o600 }); }
  let queue = Promise.resolve();
  const persist = () => {
    queue = queue.catch(() => {}).then(async () => {
      await writeFile(`${path}.tmp`, JSON.stringify([...records.values()], null, 2), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    return queue;
  };
  return {
    secret,
    get: id => records.get(id),
    find: predicate => [...records.values()].find(predicate),
    async save(order) { records.set(order.id, order); await persist(); return order; },
    async update(id, change) { const current = records.get(id); if (!current) return null; const next = change(current); records.set(id, next); await persist(); return next; },
  };
}

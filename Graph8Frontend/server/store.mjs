import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function openStore(file) {
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { rooms: [], experiments: [], goals: [] }; }
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(state),
    update: (fn) => {
      const job = queue.then(async () => {
        const next = structuredClone(state); const result = await fn(next);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(file + '.tmp', file); state = next; return result;
      });
      queue = job.catch(() => {}); return job;
    },
  };
}

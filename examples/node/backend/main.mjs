import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export default {
  info() { return { bun: process.versions.bun, platform: process.platform, pid: process.pid }; },
  async roundTrip({ text }) {
    if (typeof text !== 'string' || text.length > 10000) throw new TypeError('Expected a short text value');
    const directory = await mkdtemp(join(tmpdir(), 'weber-backend-example-'));
    try {
      await writeFile(join(directory, 'note.txt'), text, 'utf8');
      const content = await readFile(join(directory, 'note.txt'), 'utf8');
      return { text: content, sha256: createHash('sha256').update(content).digest('hex') };
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
};

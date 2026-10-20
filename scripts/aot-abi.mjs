import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function aotAbi() {
  const hash = createHash('sha256').update('weber-native-unit-v1');
  for (const path of ['vendor/hermes/include/hermes/VM/static_h.h', 'vendor/hermes/include/hermes/VM/sh_runtime.h', 'vendor/hermes/include/hermes/VM/sh_mirror.h', 'target/hermes/lib/config/libhermesvm-config.h']) hash.update(path).update(await readFile(root + path));
  return hash.digest('hex');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await aotAbi());

// Copyright (c) Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function build(output) {
  if (process.platform !== 'linux') throw new Error('The platform transport currently targets Linux');
  const headers = path.dirname(require.resolve('node-api-headers/package.json'));
  const native = path.join(output, 'native');
  fs.mkdirSync(native, { recursive: true });
  const result = spawnSync(process.env.CXX || 'c++', [
    '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-shared',
    '-I', path.join(headers, 'include'), path.join(__dirname, 'addon.cc'),
    '-o', path.join(native, 'weber_platform.node'),
  ], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native platform build failed (${result.status})`);
}
module.exports = { build };
if (require.main === module) build(path.resolve(process.argv[2] || path.join(__dirname, '../dist')));

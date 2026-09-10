// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function build(output) {
  const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'libsecret-1'], { encoding: 'utf8' }).trim().split(/\s+/);
  fs.mkdirSync(path.join(output, 'native'), { recursive: true });
  execFileSync(process.env.CXX || 'c++', ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror',
    path.join(__dirname, 'secret-store.cc'), '-o', path.join(output, 'native/weber-secret-store'), ...flags], { stdio: 'inherit', shell: false });
}
module.exports = { build };
if (require.main === module) build(path.resolve(process.argv[2] || path.join(__dirname, '../dist')));

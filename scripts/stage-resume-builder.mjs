import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(process.argv[2] ?? '../resume-builder');
const target = resolve('deploy-assets/resume-builder');
if (!existsSync(resolve(source, 'index.html')) || !existsSync(resolve(source, 'js/data.js'))) {
  throw new Error('Pass the path to a Resume Builder checkout.');
}
mkdirSync(target, { recursive: true });
rmSync(resolve(target, 'js/profile.local.js'), { force: true });
cpSync(resolve(source, 'index.html'), resolve(target, 'index.html'));
for (const folder of ['css', 'js', 'fonts']) {
  const destination = resolve(target, folder);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(resolve(source, folder), { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith('.local.js') && /^[\w.-]+\.(css|js|woff2?|ttf|png|svg)$/i.test(entry.name)) {
      cpSync(resolve(source, folder, entry.name), resolve(destination, entry.name));
    }
  }
}
// Node loads the shared document validator as an ES module.
writeFileSync(resolve(target, 'package.json'), '{"type":"module"}\n');
console.log('Staged Resume Builder static assets.');

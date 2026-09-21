import { readFile, readdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
assert.equal(manifest.version, pkg.version);
for (const key of ['display_name', 'js', 'author', 'generate_interceptor']) assert.equal(typeof manifest[key], 'string');
for (const key of ['js', 'css']) await access(new URL(`../${manifest[key]}`, import.meta.url));
for (const file of ['index.js', ...(await readdir(new URL('../src', import.meta.url))).filter(f => f.endsWith('.js')).map(f => `src/${f}`)]) {
    const url = new URL(`../${file}`, import.meta.url);
    execFileSync(process.execPath, ['--check', url.pathname.replace(/^\/([A-Z]:)/i, '$1')], { stdio: 'inherit' });
    const text = await readFile(url, 'utf8');
    assert.ok(!/D:\\RUA|sk-[A-Za-z0-9]{20,}/.test(text), `Unexpected local path/secret in ${file}`);
}
console.log(`Manifest, assets and JavaScript checks passed (${manifest.version}).`);

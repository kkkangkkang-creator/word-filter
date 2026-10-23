import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('manifest, UI and import cache-busting versions match', () => {
    const version = JSON.parse(read('manifest.json')).version;
    assert.match(read('index.js'), new RegExp(`const DISPLAY_VERSION = '${version}'`));
    assert.match(read('template.html'), new RegExp(`v${version}<`));
    for (const file of ['index.js', 'chat-batch.js']) {
        const queries = [...read(file).matchAll(/from '\.\/[\w-]+\.js(\?v=[^']*)?'/g)];
        assert.ok(queries.length > 0);
        for (const [statement, query] of queries) assert.equal(query, `?v=${version}`, `${file}: ${statement}`);
    }
});

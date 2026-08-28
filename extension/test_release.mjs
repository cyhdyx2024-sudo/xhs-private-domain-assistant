import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('./', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const content = read('content.js');
const popup = read('popup.html');
const options = read('options.html');
const optionsJs = read('options.js');
assert.equal(manifest.version, '1.0.0');
assert.match(content, /const VERSION = '1\.0\.0'/);
assert.match(content, /<span class="badge">V1\.0<\/span>/);
assert.match(popup, />V1\.0<\/span>/);
assert.match(options, />V1\.0<\/span>/);
assert.doesNotMatch(optionsJs, /leads\/export\.csv\?token=/);
assert.match(optionsJs, /leads\/export\.csv`/);
assert.match(content, /if \(!isVisible\(card\) \|\| isVirtualGhost\(card\)\) return null/);
assert.match(content, /function getVisibleContactScroller\(\)/);
assert.match(content, /isExternalActionStatusCheck\(history\.latestUserMsg\)/);

console.log('release contract: ok');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')
);

test('extension access is limited to the Google services it uses', () => {
    assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
    assert.equal(manifest.permissions.includes('downloads'), false);
    assert.equal(
        manifest.web_accessible_resources.some(resource =>
            resource.matches.includes('<all_urls>')
        ),
        false
    );
});

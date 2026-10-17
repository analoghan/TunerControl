/**
 * test-print-report.js — Report helpers (lib/print-report.js) used by the PDF exports.
 */
describe('Print report helpers', function () {
  it('escapes HTML', function () {
    assert.equal(prEsc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    assert.equal(prEsc(null), '');
  });

  it('builds a table and shows empty cells as a dash', function () {
    var html = prTable(['A', 'B'], [['1', ''], [null, '2']]);
    assert.equal((html.match(/<tr>/g) || []).length, 3);
    assert.equal((html.match(/<td>—<\/td>/g) || []).length, 2);
    assert.ok(html.indexOf('<th>A</th><th>B</th>') >= 0);
  });
});

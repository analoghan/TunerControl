// Temporary test runner for channel resolver tests
const fs = require('fs');
const path = require('path');

// Load worker.js
const workerCode = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
// Remove the self.onmessage block that references 'self'
const safeCode = workerCode.replace(/if \(typeof self[\s\S]*?^\}/m, '');
eval(safeCode);

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  \u2713 ' + name); }
  catch(e) { failed++; console.log('  \u2717 ' + name + ': ' + e.message); }
}

function buildCsv(columns, values) {
  var header = columns.map(c => '"' + c + '"').join(',');
  var units = columns.map(() => '').join(',');
  var dataRow = values.join(',');
  return header + '\n' + units + '\n' + dataRow + '\n';
}

var ALL_COLUMNS = ['Time','Engine Speed','Inlet Manifold Pressure','Exhaust Lambda Bank 1','Exhaust Lambda Bank 2','Exhaust Lambda','Fuel Mixture Aim','Fuel Closed Loop Control Bank 1 Trim','Fuel Closed Loop Control Bank 2 Trim'];
var ALL_VALUES = ['0.001','1000','100','0.98','1.02','1.0','1.0','0.5','-0.3'];
function noop() {}

console.log('Channel Resolver (via parseLog):');

check('all 8 channels present — parses without warnings', () => {
  var csv = buildCsv(ALL_COLUMNS, ALL_VALUES);
  var result = parseLog(csv, noop);
  if (result.samples.length === 0) throw new Error('No samples');
  if (result.channelWarnings.length !== 0) throw new Error('Unexpected warnings: ' + result.channelWarnings);
});

check('RPM channel missing — throws error', () => {
  var columns = ALL_COLUMNS.filter(c => c !== 'Engine Speed');
  var values = ALL_VALUES.slice(0,1).concat(ALL_VALUES.slice(2));
  var csv = buildCsv(columns, values);
  var threw = false;
  try { parseLog(csv, noop); } catch(e) { threw = true; if (!e.message.includes('Engine Speed')) throw new Error('Wrong msg: ' + e.message); }
  if (!threw) throw new Error('Did not throw');
});

check('MAP channel missing — throws error', () => {
  var columns = ALL_COLUMNS.filter(c => c !== 'Inlet Manifold Pressure');
  var values = [ALL_VALUES[0], ALL_VALUES[1]].concat(ALL_VALUES.slice(3));
  var csv = buildCsv(columns, values);
  var threw = false;
  try { parseLog(csv, noop); } catch(e) { threw = true; if (!e.message.includes('Inlet Manifold Pressure')) throw new Error('Wrong msg: ' + e.message); }
  if (!threw) throw new Error('Did not throw');
});

check('both lambda banks absent with Avg present — parses successfully', () => {
  var columns = ['Time','Engine Speed','Inlet Manifold Pressure','Exhaust Lambda','Fuel Mixture Aim','Fuel Closed Loop Control Bank 1 Trim','Fuel Closed Loop Control Bank 2 Trim'];
  var values = ['0.001','1000','100','1.0','1.0','0.5','-0.3'];
  var csv = buildCsv(columns, values);
  var result = parseLog(csv, noop);
  if (result.samples.length === 0) throw new Error('No samples');
  if (isNaN(result.samples[0].lambdaAvg)) throw new Error('lambdaAvg is NaN');
});

check('both lambda banks absent and Avg also absent — throws error', () => {
  var columns = ['Time','Engine Speed','Inlet Manifold Pressure','Fuel Mixture Aim','Fuel Closed Loop Control Bank 1 Trim','Fuel Closed Loop Control Bank 2 Trim'];
  var values = ['0.001','1000','100','1.0','0.5','-0.3'];
  var csv = buildCsv(columns, values);
  var threw = false;
  try { parseLog(csv, noop); } catch(e) { threw = true; if (!e.message.toLowerCase().includes('lambda')) throw new Error('Wrong msg: ' + e.message); }
  if (!threw) throw new Error('Did not throw');
});

check('CL trim B1 missing — emits warning', () => {
  var columns = ['Time','Engine Speed','Inlet Manifold Pressure','Exhaust Lambda','Fuel Mixture Aim','Fuel Closed Loop Control Bank 2 Trim'];
  var values = ['0.001','1000','100','1.0','1.0','-0.3'];
  var csv = buildCsv(columns, values);
  var result = parseLog(csv, noop);
  if (result.samples.length === 0) throw new Error('No samples');
  var hasB1Warning = result.channelWarnings.some(w => w.indexOf('Bank 1 Trim') !== -1);
  if (!hasB1Warning) throw new Error('Missing B1 warning');
});

check('CL trim B2 missing — emits warning', () => {
  var columns = ['Time','Engine Speed','Inlet Manifold Pressure','Exhaust Lambda','Fuel Mixture Aim','Fuel Closed Loop Control Bank 1 Trim'];
  var values = ['0.001','1000','100','1.0','1.0','0.5'];
  var csv = buildCsv(columns, values);
  var result = parseLog(csv, noop);
  if (result.samples.length === 0) throw new Error('No samples');
  var hasB2Warning = result.channelWarnings.some(w => w.indexOf('Bank 2 Trim') !== -1);
  if (!hasB2Warning) throw new Error('Missing B2 warning');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);

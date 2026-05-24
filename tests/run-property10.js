// Temporary test runner for Property 10 verification
const fs = require('fs');
const vm = require('vm');

const sandbox = {
  self: {},
  postMessage: function() {},
  console: console,
  Math: Math,
  Number: Number,
  Array: Array,
  Set: Set,
  Map: Map,
  Error: Error,
  JSON: JSON,
  Object: Object,
  String: String,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isFinite: isFinite,
  isNaN: isNaN,
  NaN: NaN,
  Infinity: Infinity,
  undefined: undefined,
};

const code = fs.readFileSync(__dirname + '/../worker.js', 'utf8');
vm.runInNewContext(code, sandbox);

const resolveChannels = sandbox.resolveChannels;

// Test 1: All channels with mixed casing
function randomCase(str) {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    result += Math.random() > 0.5 ? str[i].toUpperCase() : str[i].toLowerCase();
  }
  return result;
}

let allPass = true;

for (let trial = 0; trial < 100; trial++) {
  const header = [
    'Time',
    randomCase('Engine Speed'),
    randomCase('Inlet Manifold Pressure'),
    randomCase('Exhaust Lambda Bank 1'),
    randomCase('Exhaust Lambda Bank 2'),
    randomCase('Exhaust Lambda'),
    randomCase('Fuel Mixture Aim'),
    randomCase('Fuel Closed Loop Control Bank 1 Trim'),
    randomCase('Fuel Closed Loop Control Bank 2 Trim'),
  ];

  const r = resolveChannels(header);

  if (r.rpmIdx !== 1 || r.mapIdx !== 2 || r.lambdaB1Idx !== 3 ||
      r.lambdaB2Idx !== 4 || r.lambdaAvgIdx !== -1 ||
      r.lambdaTargetIdx !== 6 || r.clTrimB1Idx !== 7 || r.clTrimB2Idx !== 8) {
    console.log('FAIL on trial', trial, 'header:', header);
    console.log('Result:', JSON.stringify(r));
    allPass = false;
    break;
  }
}

// Test 2: Lambda_Avg fallback (B1/B2 absent)
for (let trial = 0; trial < 100; trial++) {
  const header = [
    'Time',
    randomCase('Engine Speed'),
    randomCase('Inlet Manifold Pressure'),
    randomCase('Exhaust Lambda'),
    randomCase('Fuel Mixture Aim'),
    randomCase('Fuel Closed Loop Control Bank 1 Trim'),
    randomCase('Fuel Closed Loop Control Bank 2 Trim'),
  ];

  const r = resolveChannels(header);

  if (r.rpmIdx !== 1 || r.mapIdx !== 2 || r.lambdaB1Idx !== -1 ||
      r.lambdaB2Idx !== -1 || r.lambdaAvgIdx !== 3 ||
      r.lambdaTargetIdx !== 4 || r.clTrimB1Idx !== 5 || r.clTrimB2Idx !== 6) {
    console.log('FAIL on fallback trial', trial, 'header:', header);
    console.log('Result:', JSON.stringify(r));
    allPass = false;
    break;
  }
}

if (allPass) {
  console.log('Property 10: All 200 trials PASSED');
  process.exit(0);
} else {
  process.exit(1);
}

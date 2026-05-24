/**
 * Tests for resolveInjectorChannels() — channel resolution logic.
 * Validates Requirements 5.1, 5.2, 5.3, 5.4
 */

describe('resolveInjectorChannels — basic resolution', function () {
    it('resolves all channels when all are present', function () {
        const columns = [
            'Time', 'Engine Speed', 'Inlet Manifold Pressure',
            'Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Exhaust Lambda',
            'Fuel Cylinder 1 Primary Output Pulse Width 1',
            'Fuel Cylinder 1 Primary Output Pulse Angle 1',
            'Throttle Position', 'Fuel Pressure Direct Bank 1',
            'Fuel Pressure Direct Bank 1 Aim', 'Coolant Temperature',
            'Inlet Air Temperature', 'Fuel Closed Loop Control Bank 1 Trim',
            'Fuel Closed Loop Control Bank 2 Trim', 'Fuel Mixture Aim'
        ];

        const result = resolveInjectorChannels(columns);

        assert.equal(result.time, 0);
        assert.equal(result.rpm, 1);
        assert.equal(result.map, 2);
        assert.equal(result.lambda_b1, 3);
        assert.equal(result.lambda_b2, 4);
        assert.equal(result.lambda_avg, 5);
        assert.equal(result.inj_pw, 6);
        assert.equal(result.inj_timing, 7);
        assert.equal(result.tps, 8);
        assert.equal(result.fuel_press_di, 9);
        assert.equal(result.fuel_press_di_aim, 10);
        assert.equal(result.coolant_temp, 11);
        assert.equal(result.iat, 12);
        assert.equal(result.cl_trim_b1, 13);
        assert.equal(result.cl_trim_b2, 14);
        assert.equal(result.fuel_mix_aim, 15);
        assert.deepEqual(result.warnings, []);
    });

    it('performs case-insensitive matching', function () {
        const columns = [
            'time', 'ENGINE SPEED', 'exhaust lambda bank 1'
        ];

        const result = resolveInjectorChannels(columns);

        assert.equal(result.time, 0);
        assert.equal(result.rpm, 1);
        assert.equal(result.lambda_b1, 2);
    });

    it('handles leading/trailing whitespace in column names', function () {
        const columns = [
            '  Time  ', '  Engine Speed  ', '  Exhaust Lambda  '
        ];

        const result = resolveInjectorChannels(columns);

        assert.equal(result.time, 0);
        assert.equal(result.rpm, 1);
        assert.equal(result.lambda_avg, 2);
    });

    it('returns -1 for channels not found', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1'];

        const result = resolveInjectorChannels(columns);

        assert.equal(result.map, -1);
        assert.equal(result.inj_pw, -1);
        assert.equal(result.fuel_press_di, -1);
    });
});

describe('resolveInjectorChannels — required channel validation', function () {
    it('throws when Engine Speed (rpm) is not found', function () {
        const columns = ['Time', 'Exhaust Lambda Bank 1', 'Throttle Position'];

        assert.throws(function () {
            resolveInjectorChannels(columns);
        }, 'Required channel "Engine Speed" not found');
    });

    it('throws when no lambda channel is available', function () {
        const columns = ['Time', 'Engine Speed', 'Throttle Position'];

        assert.throws(function () {
            resolveInjectorChannels(columns);
        }, 'No lambda channel found');
    });

    it('does not throw when only lambda_b1 is available', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1'];
        const result = resolveInjectorChannels(columns);
        assert.equal(result.lambda_b1, 2);
    });

    it('does not throw when only lambda_b2 is available', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 2'];
        const result = resolveInjectorChannels(columns);
        assert.equal(result.lambda_b2, 2);
    });

    it('does not throw when only lambda_avg is available', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda'];
        const result = resolveInjectorChannels(columns);
        assert.equal(result.lambda_avg, 2);
    });
});

describe('resolveInjectorChannels — optional channel warnings', function () {
    it('generates warning when inj_pw is missing', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1'];
        const result = resolveInjectorChannels(columns);
        assert.ok(result.warnings.some(function (w) { return w.includes('Injector PW'); }));
    });

    it('generates warning when fuel_press_di is missing', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1'];
        const result = resolveInjectorChannels(columns);
        assert.ok(result.warnings.some(function (w) { return w.includes('DI fuel pressure'); }));
    });

    it('generates warning when inj_timing is missing', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1'];
        const result = resolveInjectorChannels(columns);
        assert.ok(result.warnings.some(function (w) { return w.includes('Injection timing'); }));
    });

    it('generates warning when cl_trim_b1 is missing', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1'];
        const result = resolveInjectorChannels(columns);
        assert.ok(result.warnings.some(function (w) { return w.includes('Bank 1'); }));
    });

    it('generates warning when cl_trim_b2 is missing', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1'];
        const result = resolveInjectorChannels(columns);
        assert.ok(result.warnings.some(function (w) { return w.includes('Bank 2'); }));
    });

    it('generates 5 warnings when all optional channels are missing', function () {
        const columns = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1'];
        const result = resolveInjectorChannels(columns);
        assert.equal(result.warnings.length, 5);
    });

    it('generates no warnings when all channels are present', function () {
        const columns = [
            'Time', 'Engine Speed', 'Inlet Manifold Pressure',
            'Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Exhaust Lambda',
            'Fuel Cylinder 1 Primary Output Pulse Width 1',
            'Fuel Cylinder 1 Primary Output Pulse Angle 1',
            'Throttle Position', 'Fuel Pressure Direct Bank 1',
            'Fuel Pressure Direct Bank 1 Aim', 'Coolant Temperature',
            'Inlet Air Temperature', 'Fuel Closed Loop Control Bank 1 Trim',
            'Fuel Closed Loop Control Bank 2 Trim', 'Fuel Mixture Aim'
        ];
        const result = resolveInjectorChannels(columns);
        assert.equal(result.warnings.length, 0);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { asUint32Array, convertToInt32Array, convertToUint32Array, isFloat64Vector, isInt32Vector, isNumberVector, isUint32Vector } from './utils.js';

describe('numeric vector views', () => {
    it('accepts only the representations produced by profile extraction', () => {
        for (const value of [[], [1]]) {
            assert.equal(isInt32Vector(value), true);
            assert.equal(isUint32Vector(value), true);
            assert.equal(isFloat64Vector(value), true);
            assert.equal(isNumberVector(value), true);
        }
        assert.equal(isInt32Vector(new Int32Array([-1])), true);
        assert.equal(isUint32Vector(new Uint32Array([0xffffffff])), true);
        assert.equal(isFloat64Vector(new Float64Array([0.5])), true);
        assert.equal(isNumberVector(new Int32Array()), false);
        assert.equal(isNumberVector(new Uint32Array()), true);
        assert.equal(isInt32Vector(new Uint32Array()), false);
        assert.equal(isUint32Vector(new Int32Array()), false);
        assert.equal(isFloat64Vector(new Uint32Array()), false);
        assert.equal(isInt32Vector(new Float64Array([0.5])), false);
        assert.equal(isNumberVector(new Float64Array([0.5])), true);
        for (const value of [null, {}, '[]', new Uint8Array(), new Int16Array(), new Float32Array(), new DataView(new ArrayBuffer(8)), new BigInt64Array(), new BigUint64Array()]) {
            assert.equal(isInt32Vector(value), false);
            assert.equal(isUint32Vector(value), false);
            assert.equal(isFloat64Vector(value), false);
            assert.equal(isNumberVector(value), false);
        }
    });

    it('reuses 32-bit storage with its view offset and length', () => {
        const source = new Uint32Array([99, 0xffffffff, 42, 99]).subarray(1, 3);
        const unsigned = asUint32Array(source);
        assert.equal(unsigned, source);
        assert.equal(unsigned.buffer, source.buffer);
        assert.equal(unsigned.byteOffset, source.byteOffset);
        assert.deepEqual([...unsigned], [0xffffffff, 42]);
        assert.equal(asUint32Array(unsigned), unsigned);
        assert.equal(unsigned.length, source.length);
    });

    it('allocates storage for ordinary arrays and independent mutable conversions', () => {
        const source = [1, -2];
        const unsigned = asUint32Array(source);
        assert.deepEqual([...unsigned], [1, 0xfffffffe]);
        unsigned[0] = 10;
        assert.deepEqual(source, [1, -2]);

        const signed = new Int32Array([1, -2]);
        const signedCopy = convertToInt32Array(signed, 1);
        const unsignedCopy = convertToUint32Array(signed, 1);
        assert.notEqual(signedCopy.buffer, signed.buffer);
        assert.notEqual(unsignedCopy.buffer, signed.buffer);
        assert.deepEqual([...signedCopy], [1, -2, 0]);
        assert.deepEqual([...unsignedCopy], [1, 0xfffffffe, 0]);
    });
});

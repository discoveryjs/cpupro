// A single base 64 digit can contain 6 bits of data. For the base 64 variable
// length quantities we use in the source map spec, the first bit is the sign,
// the next four bits are the actual value, and the 6th bit is the
// continuation bit. The continuation bit tells us whether there are more
// digits in this value following this digit.
//
//   Continuation
//   |    Sign
//   |    |
//   V    V
//   101011

const VLQ_BASE_SHIFT = 5;
const VLQ_BASE_MASK = 0b011111;
const VLQ_CONTINUATION_BIT = 0b100000;

const base64Dict = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const intToBase64Code = new Uint8Array(64);
const b64map = new Uint8Array(256);
base64Dict.split('').forEach((ch, digit) => {
    intToBase64Code[digit] = ch.charCodeAt();
    b64map[ch.charCodeAt()] = digit;
});

b64map[44] = 255; // ,
b64map[59] = 255; // ;

export function decode(str, index, buffer, bufferIndex) {
    if (str[index] === 65) {
        return 1;
    }

    let value = 0;
    let shift = 0;
    let consumed = 0;

    for (; index < str.length; index++) {
        const digit = b64map[str[index]];

        if (digit === 255) {
            break;
        }

        value |= (digit & VLQ_BASE_MASK) << shift;
        consumed++;

        // if digit is less of equal to mask then it has a continuation bit
        // this is simpler form of (digit & VLQ_CONTINUATION_BIT) === 0
        if ((digit & VLQ_CONTINUATION_BIT) === 0) {
            break;
        }

        shift += VLQ_BASE_SHIFT;
    }

    // Converts to a two-complement value from a value where the sign bit is
    // placed in the least significant bit. For example, as decimals:
    //   2 (10 binary) becomes 1, 3 (11 binary) becomes -1
    //   4 (100 binary) becomes 2, 5 (101 binary) becomes -2
    buffer[bufferIndex] += (value & 1) === 1
        ? -(value >> 1)
        : (value >> 1);

    return consumed;
}

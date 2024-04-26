// Return a vector (0.0->1.0) that is a hash of the input string.
// The hash is computed to favor early characters over later ones, so
// that strings with similar starts have similar vectors. Only the first
// 6 characters are considered.
const MAX_CHAR = 6;

function generateHash(str: string) {
    let hash = 0;
    let maxHash = 0;
    let weight = 1;
    const mod = 10;

    if (str) {
        for (let i = 0; i < str.length; i++) {
            if (i > MAX_CHAR) {
                break;
            }
            hash += weight * (str.charCodeAt(i) % mod);
            maxHash += weight * (mod - 1);
            weight *= 0.7;
        }

        if (maxHash > 0) {
            hash = hash / maxHash;
        }
    }

    return hash;
}

export function generateColorVector(str: string) {
    return str ? generateHash(str) : 0;
}

export function calculateColor(hue: string, vector: number) {
    let r: number;
    let g: number;
    let b: number;

    switch (hue) {
        case 'red': {
            r = 200 + Math.round(55 * vector);
            g = 50 + Math.round(80 * vector);
            b = g;
            break;
        }

        case 'orange': {
            r = 190 + Math.round(65 * vector);
            g = 90 + Math.round(65 * vector);
            b = 0;
            break;
        }

        case 'yellow': {
            r = 175 + Math.round(55 * vector);
            g = r;
            b = 50 + Math.round(20 * vector);
            break;
        }

        case 'green': {
            r = 50 + Math.round(60 * vector);
            g = 200 + Math.round(55 * vector);
            b = r;
            break;
        }

        case 'pastelgreen': {
            // rgb(163,195,72) - rgb(238,244,221)
            r = 163 + Math.round(75 * vector);
            g = 195 + Math.round(49 * vector);
            b = 72 + Math.round(149 * vector);
            break;
        }

        case 'blue': {
            // rgb(91,156,221) - rgb(217,232,247)
            r = 91 + Math.round(126 * vector);
            g = 156 + Math.round(76 * vector);
            b = 221 + Math.round(26 * vector);
            break;
        }

        case 'aqua': {
            r = 50 + Math.round(60 * vector);
            g = 165 + Math.round(55 * vector);
            b = g;
            break;
        }

        case 'cold': {
            r = 0 + Math.round(55 * (1 - vector));
            g = 0 + Math.round(230 * (1 - vector));
            b = 200 + Math.round(55 * vector);
            break;
        }

        default: {
            // original warm palette
            // r = 200 + Math.round(55 * vector);
            // g = 0 + Math.round(230 * (1 - vector));
            // b = 0 + Math.round(55 * (1 - vector));

            r = 50 + 70 + Math.round(120 * vector);
            g = 50 + 93 + Math.round(90 * (1 - vector));
            b = 61 + Math.round(150 * (1000 * vector % 2 ? vector : (1 - vector)));
        }
    }

    return [r, g, b].join(',');
}

import { methods } from './jora/index.mjs';

// Script extensions run before setup collects the Jora method registry.
Object.assign(methods, {
    consoleLog(value, ...args) {
        console.log(value, ...args);

        return value;
    }
});

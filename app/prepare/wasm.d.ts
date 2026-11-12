// A WASM module is bundled as base64 (the .wasm loader of discovery-build, the cpupro-test-assets plugin in tests)
declare module '*.wasm' {
    const source: string;
    export default source;
}

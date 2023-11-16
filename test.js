function asd() {
    const x = Date.now();
    while (Date.now() < x + 100) {}
}

asd();

setTimeout(() => {
    asd()
}, 500);

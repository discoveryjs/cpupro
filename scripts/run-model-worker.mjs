// Worker of run-model.mjs: loads one trace into its own model and runs the script on it
import { parentPort, workerData } from 'node:worker_threads';

const { modelScriptUrl, scriptUrl, file, options } = workerData;
const { model } = await import(modelScriptUrl);
const { default: run } = await import(scriptUrl);

await model.loadDataFromFile(file);
parentPort.postMessage({ result: await run(model, { file, options }) });

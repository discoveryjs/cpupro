import { vi } from 'vitest';

declare module 'vitest' {
	export interface ProvidedContext {
		useWasm: boolean;
		useUsage: boolean;
	}
}

vi.stubGlobal('navigator', { hardwareConcurrency: 2 });

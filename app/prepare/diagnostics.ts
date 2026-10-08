export type DiagnosticLevel = 'warn' | 'error';
export type Diagnostic = {
    level: DiagnosticLevel;
    // Outer to inner owners of the source of a message, e.g. ['Session 1', 'cpuprofile']
    scope: string[];
    message: string;
    // Plain structured-cloneable data, so a diagnostic can cross a worker boundary
    details?: Record<string, unknown>;
};
export type Diagnose = {
    (level: DiagnosticLevel, message: string, details?: Record<string, unknown>): void;
    withScope(name: string): Diagnose;
};
export type ReportDiagnostic = (diagnostic: Diagnostic) => void;

function createDiagnose(report: ReportDiagnostic, scope: string[] = []): Diagnose {
    return Object.assign(
        (level: DiagnosticLevel, message: string, details?: Record<string, unknown>) => {
            report(details !== undefined
                ? { level, scope, message, details }
                : { level, scope, message }
            );
        },
        {
            withScope: (name: string) => createDiagnose(report, [...scope, name])
        }
    );
}

export function printDiagnostic({ level, scope, message, details }: Diagnostic) {
    const text = scope.length > 0 ? `[${scope.join(' / ')}] ${message}` : message;

    if (details !== undefined) {
        console[level](text, details);
    } else {
        console[level](text);
    }
}

// Used when no diagnose is provided
export const diagnoseToConsole = createDiagnose(printDiagnostic);

// Diagnostics are accumulated; onReport is an additional action, e.g. printDiagnostic
export function createDiagnosticsCollector({ onReport }: { onReport?: ReportDiagnostic } = {}) {
    const diagnostics: Diagnostic[] = [];
    const diagnose = createDiagnose(diagnostic => {
        diagnostics.push(diagnostic);
        onReport?.(diagnostic);
    });

    return { diagnostics, diagnose };
}

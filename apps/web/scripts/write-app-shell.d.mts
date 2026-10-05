export interface AppShellManifest { id: string; protocol: number; entries: Array<{ url: string; integrity: string }> }
export function writeAppShell(dist: string, protocol: number): Promise<AppShellManifest>;

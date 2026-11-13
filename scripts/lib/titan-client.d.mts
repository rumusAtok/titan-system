export declare const config: {
  keycloakUrl: string;
  gatewayUrl: string;
  mqttUrl: string;
  mqttUser: string;
  mqttPassword: string;
  demoPassword: string;
  env: Record<string, string | undefined>;
};
export declare const TENANT_A: string;
export declare const TENANT_B: string;
export declare function loadEnv(): Record<string, string | undefined>;
export declare function tokenFor(username: string): Promise<string>;
export declare function claimsOf(token: string): Record<string, any>;
export declare class ApiError extends Error {
  status: number;
  body: any;
}
export declare function api<T = any>(username: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
export declare function rawApi<T = any>(
  username: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: T; headers: Headers }>;
export declare const sleep: (ms: number) => Promise<void>;
export declare function waitFor<T>(fn: () => Promise<T> | T, options?: { timeoutMs?: number; intervalMs?: number; what?: string }): Promise<NonNullable<T>>;

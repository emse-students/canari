/* tslint:disable */
/* eslint-disable */

export class WasmMlsClient {
    free(): void;
    [Symbol.dispose](): void;
    add_member(group_id: string, key_package_bytes: Uint8Array): Array<any>;
    create_group(group_id: string): void;
    generate_key_package(): Uint8Array;
    get_groups(): Array<any>;
    constructor(user_id: string, state_bytes?: Uint8Array | null, pin?: string | null);
    process_incoming_message(group_id: string, message_bytes: Uint8Array): string | undefined;
    process_welcome(welcome_bytes: Uint8Array): string;
    save_state(pin?: string | null): Uint8Array;
    send_message(group_id: string, message: string): Uint8Array;
}

export function decrypt_with_pin(pin: string, encrypted_data: Uint8Array): Uint8Array;

export function encrypt_with_pin(pin: string, data: Uint8Array): Uint8Array;

export function init_logger(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmmlsclient_free: (a: number, b: number) => void;
    readonly decrypt_with_pin: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encrypt_with_pin: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly init_logger: () => void;
    readonly wasmmlsclient_add_member: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmmlsclient_create_group: (a: number, b: number, c: number) => [number, number];
    readonly wasmmlsclient_generate_key_package: (a: number) => [number, number, number, number];
    readonly wasmmlsclient_get_groups: (a: number) => any;
    readonly wasmmlsclient_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly wasmmlsclient_process_incoming_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasmmlsclient_process_welcome: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmmlsclient_save_state: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmmlsclient_send_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

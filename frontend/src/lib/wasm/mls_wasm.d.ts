/* tslint:disable */
/* eslint-disable */

export class WasmMlsClient {
    free(): void;
    [Symbol.dispose](): void;
    add_member(group_id: string, key_package_bytes: Uint8Array): Array<any>;
    /**
     * Add multiple members in a single commit (single epoch increment). Stage-only (C7-A): the
     * commit is NOT merged - the caller validates it server-side then merge/clear, and reads the
     * post-merge ratchet tree via `export_ratchet_tree`.
     * `key_packages` is a JS Array of Uint8Array.
     * Returns [commit: Uint8Array, welcome: Uint8Array, added_indices: number[],
     * skipped_indices: number[]].
     * `added_indices` lists, in order, the positions within the input `key_packages` array that
     * were actually included in the commit - positions skipped (invalid, or already a member of
     * the group) are omitted rather than collapsing to a bare count, so the caller can correctly
     * map indices back to its own per-device bookkeeping. `skipped_indices` lists the positions of
     * KeyPackages dropped because they were **invalid/undeserializable** (not the already-member
     * dedup), so the caller can surface a non-silent member loss. [[C5]]
     */
    add_members_bulk(group_id: string, key_packages: Array<any>): Array<any>;
    /**
     * Annule le commit *stage* (ADD ou REMOVE) quand le serveur le REJETTE. L'epoch local reste
     * inchange (aucun fork) et un nouveau commit peut etre genere. [[C7]] Option A.
     */
    clear_pending_commit(group_id: string): void;
    create_group(group_id: string): void;
    /**
     * Permanent purge of a group (Poison Pill): memory, OpenMLS storage, and epoch lock
     * set to MAX. No Welcome will ever be accepted for this groupId.
     */
    drop_group(group_id: string): void;
    /**
     * Export a self-contained GroupInfo (ratchet tree included) for `group_id`, to be stored by the
     * delivery service and served to an authorized member who then joins via `join_by_external_commit`.
     */
    export_group_info(group_id: string): Uint8Array;
    /**
     * Export the group's current ratchet tree (TLS-serialised). For an ADD this MUST be called
     * AFTER `merge_pending_commit` so the tree reflects the post-commit epoch the newly welcomed
     * member joins. [[C7]]
     */
    export_ratchet_tree(group_id: string): Uint8Array;
    export_secret(group_id: string, label: string, context: Uint8Array | null | undefined, key_len: number): Uint8Array;
    /**
     * Wipes any existing orphan state for this groupId then creates a fresh group.
     * Use for re-bootstrap after losing local MLS state (phantom group recovery).
     */
    force_create_group(group_id: string): void;
    forget_group(group_id: string, min_epoch: number): void;
    generate_key_package(): Uint8Array;
    generate_key_packages(count: number): Array<any>;
    /**
     * Returns the current MLS epoch for a group as an f64 (a plain JS `number`). wasm-bindgen has
     * no u64 -> JS number mapping (it would yield a BigInt); f64 represents every epoch exactly up
     * to 2^53, far beyond any realistic group lifetime, so there is no truncation. [[S4]]
     */
    get_epoch(group_id: string): number;
    get_groups(): Array<any>;
    /**
     * Join a group via an external commit built from a served GroupInfo. The returned group is at
     * the new epoch with the commit STAGED: submit the commit for server epoch validation (against
     * the GroupInfo's base epoch), then `merge_pending_commit` on accept, or `forget_group` +
     * retry with a fresher GroupInfo on reject (an external commit cannot be cleared). Returns
     * [group_id: string, commit: Uint8Array].
     */
    join_by_external_commit(group_info_bytes: Uint8Array): Array<any>;
    key_package_has_private(key_package_bytes: Uint8Array): boolean;
    /**
     * Merge le commit *stage* (ADD ou REMOVE) APRES acceptation serveur (`validateCommit`). Avance
     * l'epoch local. Pendant de `clear_pending_commit`. [[C7]] Option A : valider-puis-merger.
     */
    merge_pending_commit(group_id: string): void;
    constructor(user_id: string, device_id: string, state_bytes?: Uint8Array | null, pin?: string | null);
    process_incoming_message(group_id: string, message_bytes: Uint8Array): string | undefined;
    /**
     * Returns the raw decrypted bytes of an MLS application message (proto-encoded AppMessage).
     */
    process_incoming_message_bytes(group_id: string, message_bytes: Uint8Array): Uint8Array | undefined;
    /**
     * Decrypts a batch of MLS ciphertexts for one group in ratchet order, in a single
     * JS<->WASM crossing. Per-message failures are captured instead of aborting the whole
     * batch, so the caller can map each outcome independently (history catch-up path).
     *
     * `messages` is a JS Array of `Uint8Array`. Returns a JS Array of plain objects, one
     * per input, preserving order:
     * - `{ ok: true, data: Uint8Array }` decrypted application plaintext,
     * - `{ ok: true, data: null }` control message with no plaintext,
     * - `{ ok: false, error: string }` recoverable per-message decrypt error.
     */
    process_incoming_messages_batch(group_id: string, messages: Array<any>): Array<any>;
    process_welcome(welcome_bytes: Uint8Array, ratchet_tree_bytes?: Uint8Array | null): string;
    /**
     * Remove all devices of one or more users from a group.
     * `user_ids` is a JS Array of strings (usernames/identities).
     * Returns the serialized commit bytes to broadcast to remaining group members.
     */
    remove_members(group_id: string, user_ids: Array<any>): Uint8Array;
    /**
     * Remove specific device leaves by their `userId:deviceId` identity string.
     * Only removes the targeted leaves, leaving other devices of the same user intact.
     */
    remove_members_by_device(group_id: string, device_identities: Array<any>): Uint8Array;
    save_state(pin?: string | null): Uint8Array;
    send_message(group_id: string, message: string): Uint8Array;
    /**
     * Encrypts raw bytes (e.g. a proto-encoded AppMessage) as the MLS application payload.
     */
    send_message_bytes(group_id: string, message_bytes: Uint8Array): Uint8Array;
}

export function decrypt_with_pin(pin: string, encrypted_data: Uint8Array): Uint8Array;

/**
 * Argon2 + ChaCha20 encrypt of a plain MLS CBOR snapshot. Safe to call from a Web Worker.
 */
export function encrypt_mls_state_blob(plain_state: Uint8Array, pin: string): Uint8Array;

export function encrypt_with_pin(pin: string, data: Uint8Array): Uint8Array;

export function init_logger(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmmlsclient_free: (a: number, b: number) => void;
    readonly decrypt_with_pin: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encrypt_mls_state_blob: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encrypt_with_pin: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly init_logger: () => void;
    readonly wasmmlsclient_add_member: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmmlsclient_add_members_bulk: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly wasmmlsclient_clear_pending_commit: (a: number, b: number, c: number) => [number, number];
    readonly wasmmlsclient_create_group: (a: number, b: number, c: number) => [number, number];
    readonly wasmmlsclient_drop_group: (a: number, b: number, c: number) => void;
    readonly wasmmlsclient_export_group_info: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmmlsclient_export_ratchet_tree: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmmlsclient_export_secret: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly wasmmlsclient_force_create_group: (a: number, b: number, c: number) => [number, number];
    readonly wasmmlsclient_forget_group: (a: number, b: number, c: number, d: number) => void;
    readonly wasmmlsclient_generate_key_package: (a: number) => [number, number, number, number];
    readonly wasmmlsclient_generate_key_packages: (a: number, b: number) => [number, number, number];
    readonly wasmmlsclient_get_epoch: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmmlsclient_get_groups: (a: number) => any;
    readonly wasmmlsclient_join_by_external_commit: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmmlsclient_key_package_has_private: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmmlsclient_merge_pending_commit: (a: number, b: number, c: number) => [number, number];
    readonly wasmmlsclient_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly wasmmlsclient_process_incoming_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasmmlsclient_process_incoming_message_bytes: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasmmlsclient_process_incoming_messages_batch: (a: number, b: number, c: number, d: any) => any;
    readonly wasmmlsclient_process_welcome: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasmmlsclient_remove_members: (a: number, b: number, c: number, d: any) => [number, number, number, number];
    readonly wasmmlsclient_remove_members_by_device: (a: number, b: number, c: number, d: any) => [number, number, number, number];
    readonly wasmmlsclient_save_state: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmmlsclient_send_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasmmlsclient_send_message_bytes: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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

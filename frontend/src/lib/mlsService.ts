export type { IMlsService } from '$lib/mls-client';
import type { IMlsService } from '$lib/mls-client';
import { TauriMlsService } from './services/TauriMlsService';
import { WebMlsService } from './services/WebMlsService';
import { isTauriRuntime } from '$lib/utils/openExternal';

/** Platform-selected MLS service constructor: resolves to `TauriMlsService` inside Tauri builds and `WebMlsService` in the browser/PWA. */
export const MlsService: new () => IMlsService = isTauriRuntime() ? TauriMlsService : WebMlsService;

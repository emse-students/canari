// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      token: string | null;
    }
    interface PageData {
      /** Per-route SEO overrides for {@link import('$lib/components/seo/SeoHead.svelte').default}. */
      seo?: import('$lib/seo/types').SeoMeta;
    }
    // interface PageState {}
    // interface Platform {}
  }

  interface Window {
    __TAURI_INTERNALS__?: any;
    /** Set by the root layout once mounted; read by the old-WebView guard of app.html. */
    __canariMounted?: boolean;
  }
}

export {};

import { currentUserId, fetchMyProfile, type UserProfile } from '$lib/stores/user';
import { authentikUrl } from '$lib/stores/auth';
import { alumniLinkReminderDue, miconnectSourcesSettingsUrl } from './alumniLink';
import { openExternal } from '$lib/utils/openExternal';
import { Log } from '$lib/utils/Log';

/**
 * The Alumni link reminder's ONE reading, shared by the feed card and the settings row so that both
 * decide from the same fact (`alumniLinkReminderDue` on the reader's OWN profile, cached and shared
 * with every other caller) and open the same page. Call it during a component's initialisation: it
 * registers the effect that reads the profile. An unknown link shows nothing.
 *
 * `due` ignores any dismissal - the card adds its own (`prompt-alumni-link`), the settings row never
 * does, so the way back to the link outlives the card's cross.
 */
export function followAlumniLinkReminder(): { readonly due: boolean; open: () => void } {
  /**
   * Whether the profile, at the instant it was read, makes the link due. The date is read with the
   * profile, never inside a `$derived`: nothing re-runs a derivation when the clock moves, so a date
   * read there was only ever the instant of the profile's arrival anyway - said here, not implied.
   */
  let dueByProfile = $state(false);
  /** Read when needed, never at mount: most screens that mount a reminder never get a due profile. */
  const target = () => miconnectSourcesSettingsUrl(authentikUrl());

  $effect(() => {
    const id = currentUserId();
    dueByProfile = false;
    if (!id) return;
    let live = true;
    fetchMyProfile()
      .then((p) => {
        if (live) dueByProfile = profileMakesLinkDue(p);
      })
      .catch((err) => Log.d('alumniLink', 'own profile not read, no reminder', err));
    return () => {
      live = false;
    };
  });

  const due = $derived(dueByProfile && !!target());

  return {
    get due() {
      return due;
    },
    open() {
      Log.d('alumniLink', 'link tapped');
      const url = target();
      if (url) void openExternal(url);
    },
  };
}

/** {@link alumniLinkReminderDue} for `profile` at this instant. */
function profileMakesLinkDue(profile: UserProfile | null): boolean {
  return !!profile && alumniLinkReminderDue(profile, new Date());
}

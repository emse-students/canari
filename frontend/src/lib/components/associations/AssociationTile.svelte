<script lang="ts">
  /**
   * ONE TILE FOR AN ASSOCIATION OR A LIST, WHEREVER A WALL OF THEM IS DRAWN.
   *
   * `/associations` and `/lists` drew this card FIVE times between them - "mes associations", "toutes
   * les associations", the archived fold, a list shelf, and the archived list fold - and every copy
   * carried the same two defects, which is what five copies of a decision always means: fixing one
   * fixes one.
   *
   * **The name was `truncate`d and the description cropped at `max-h-[2.75rem]`.** The first cuts a
   * name mid-word with no way to read the rest, and this is a wall of PROPER NOUNS, where the tail is
   * often the distinguishing part. The second is a raw pixel height against a line box whose height it
   * does not know. MEASURED against this app's own compiled CSS: that crop is 44px where the line box
   * is 20.625px, so it stopped 2.13 lines in and left the top of the third line's letters showing.
   *
   * The name now wraps and the description is line-CLAMPED, which cuts on a line boundary and says so
   * with an ellipsis - 165px of description becomes 62px, exactly three line boxes. **The clamp goes
   * on the CONTAINER and not on the paragraph**, which is the part worth writing down: a `-webkit-box`
   * clamps the lines of everything inside it, so two paragraphs are cut once at the third line,
   * whereas clamping the first paragraph instead cuts each one separately and rendered 95px where 57
   * was asked for - a truncation that forgot to truncate.
   *
   * **AND IT CARRIES THE ASSOCIATION'S COLOUR, which existed all along and no tile read.**
   * `Association.color` is what the calendar and the "Carte de la Vie Asso" have used for months, and
   * `cardGrid.ts` sized its 15rem minimum with "an association's colour bar" explicitly in the budget
   * - a bar that was never drawn. `CardTile` already implements exactly that accent (the top bar, the
   * hover outline, a `contrastColor`ed badge), so this is a call, not a re-implementation, and the
   * fallback is the one the rest of the app already spells - see `associations/accent.ts`.
   *
   * **THE FOOTER CARRIES THE READER'S ROLE WHERE THERE IS ONE, AND THE MEMBER COUNT ONLY WHERE THERE
   * IS NOT.** `/api/associations/me/list` (`listByUser`) returns `role`, `permissions` and `isAdmin`
   * and NO `memberCount`, so `memberCount ?? 0` printed "0 membres" on every card of "Mes
   * associations" - a card claiming zero members of an association its reader belongs to, which
   * contradicts itself AND contradicts the real count the same association shows one section lower,
   * where `list()` attaches one. The answer is not to go and fetch the count: that section is about
   * the reader's own place in each association, so the footer says THAT, in the yellow pill that used
   * to sit beside the name. Where no role is known - "Toutes les associations", the archived fold,
   * every list shelf - nothing changes: the count stays, and `isMember` still adds its "Membre" note.
   *
   * The avatar stays beside the name rather than going into `CardTile`'s header frame, which is why
   * that header is now optional: `AssociationAvatar` falls back to INITIALS, and an association with
   * no logo showing a generic glyph would lose the one thing that tells it apart.
   */
  import { associationSecondLogoSrc, type Association } from '$lib/associations/api';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import { associationAccent } from '$lib/associations/accent';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The association or promo list this tile stands for. */
    association: Association;
    /** Where the tile navigates - `/associations/<slug>` or `/lists/<slug>`, the caller's decision. */
    href: string;
    /**
     * True when the signed-in user belongs to it; adds the "Membre" note to the footer - only where
     * no `role` is known, since a role says the same thing and more.
     */
    isMember?: boolean;
  }

  let { association, href, isMember = false }: Props = $props();

  /**
   * The accent, from the ONE derivation - which is what this comment used to CLAIM and was wrong
   * about: it said the fallback was "the same answer the calendar, the trombinoscope and the shop
   * already give" while seeding on `name` where all three seed on `id`. An association with no
   * colour set was one hue here and another in the calendar. See `associations/accent.ts`.
   */
  const accent = $derived(associationAccent(association));
  const description = $derived(association.description?.trim() ?? '');
  const memberCount = $derived(association.memberCount ?? 0);
  const isList = $derived(association.type === 'list');

  /**
   * A list's SECOND theme - the one it runs beside the campaign's public one.
   *
   * Either half may be present without the other: a list can be renamed before its second logo is
   * uploaded, and a logo can be uploaded before the name is decided. So the block is drawn when
   * EITHER exists, and the name falls back to the main one for the avatar's initials - never for
   * the label, which would print the same name twice.
   */
  const secondName = $derived(isList ? (association.name2?.trim() ?? '') : '');
  const secondLogoUrl = $derived(
    isList ? associationSecondLogoSrc(association.logoMediaId2) : null
  );
  const hasSecondTheme = $derived(Boolean(secondName) || Boolean(secondLogoUrl));

  /**
   * THE COUNT IS FOR ASSOCIATIONS, NOT FOR LISTS (user, 2026-09-22). A list's card is read to find
   * a campaign, and "0 membres" on a list whose members have not been registered yet says nothing
   * a reader wants - the shelf it sits on already says what year it belongs to. The archived and
   * "Membre" notes stay on both, because those answer questions the shelf does not.
   */
  const showsMemberCount = $derived(!isList);
</script>

<a {href} class="block h-full">
  <CardTile
    accentColor={accent}
    class="h-full {association.archived ? 'opacity-75 transition-opacity hover:opacity-100' : ''}"
  >
    <div class="flex h-full flex-col gap-2 p-4">
      <div class="flex items-start gap-3">
        <AssociationAvatar name={association.name} logoUrl={association.logoUrl} size="lg" />
        <div class="min-w-0 flex-1">
          {#if association.parentName}
            <div class="text-text-muted text-2xs font-bold tracking-wide uppercase">
              {association.parentName}
            </div>
          {/if}
          <!--
            `line-clamp-3` and NOT `truncate`: the clamp is a MAXIMUM, so a one-word name still
            costs one line and only a genuinely long one spends three - which is why three rather
            than two, after seeing a real wall render at the real 15rem column with the real
            compiled CSS. `[overflow-wrap:anywhere]` is the floor under it: a single unbroken token
            longer than the column (an acronym, a URL-ish name) has no break opportunity at all,
            and without this it widens its grid column instead of wrapping, which is the one way a
            card wall stops being a wall.
          -->
          <h3 class="text-text-main line-clamp-3 leading-snug font-bold [overflow-wrap:anywhere]">
            {association.name}
          </h3>
        </div>
      </div>

      <!--
        THE SECOND THEME, SMALL, UNDER BOTH MAIN ONES (user, 2026-09-22: *"affiche, s'ils sont
        presents, les logos et titres fake en petit en dessous des principaux"*). It is a campaign
        list's other identity, so it is subordinate on purpose: `sm` is the 24px avatar against the
        main `lg`'s 48px, and the label takes the muted colour the parent name above already uses.

        NO "LISTE 2026" PILL ANY MORE. It repeated the shelf heading this card sits under
        (*"c'est deja dans Campagnes 2026, pourquoi doubler ?"*), which is the only place the year
        needs saying.
      -->
      {#if hasSecondTheme}
        <div class="-mt-1 flex items-center gap-2">
          <AssociationAvatar
            name={secondName || association.name}
            logoUrl={secondLogoUrl}
            size="sm"
          />
          {#if secondName}
            <span
              class="text-text-muted line-clamp-2 min-w-0 text-xs font-semibold [overflow-wrap:anywhere]"
            >
              {secondName}
            </span>
          {/if}
        </div>
      {/if}

      {#if description}
        <!--
          The clamp is on THIS element and not on the markdown's paragraphs - see the docblock: a
          `-webkit-box` clamps everything it contains as one run of lines, and clamping a paragraph
          instead renders more lines than it promises (95px against the 57px asked for).
        -->
        <div
          class="text-text-muted line-clamp-3 [&_.post-markdown]:text-sm [&_.post-markdown]:leading-snug [&_.post-markdown_p]:m-0"
        >
          <ProfileBioMarkdown source={description} compact />
        </div>
      {/if}

      <!--
        `mt-auto` pins the footer to the bottom of whatever height the grid row settles on, so the
        roles and the counts line up across a row instead of floating at five different heights.

        The role REPLACES the count rather than joining it, and it is the same pill that used to sit
        beside the name rather than a second styling of one idea - see the docblock.
      -->
      {#if association.role}
        <div class="mt-auto pt-1">
          <span class="text-cn-dark bg-cn-yellow/20 rounded-full px-2 py-0.5 text-xs font-semibold">
            {association.role}
          </span>
        </div>
      {:else if showsMemberCount || association.archived || isMember}
        <p class="text-text-muted mt-auto pt-1 text-xs">
          {#if showsMemberCount}
            {memberCount !== 1
              ? m.assoc_member_count_many({ count: memberCount })
              : m.assoc_member_count_one({ count: memberCount })}
          {/if}
          <!--
            The separator belongs to the COUNT, not to the note: a list prints no count, so a
            leading middot would open the line with punctuation standing for nothing.
          -->
          {#if association.archived}
            <span class="font-semibold">
              {#if showsMemberCount}&#183;{/if}
              {m.assoc_list_archived_badge()}
            </span>
          {:else if isMember}
            <span class="text-cn-dark font-semibold">
              {#if showsMemberCount}&#183;{/if}
              {m.assoc_list_member_badge()}
            </span>
          {/if}
        </p>
      {/if}
    </div>
  </CardTile>
</a>

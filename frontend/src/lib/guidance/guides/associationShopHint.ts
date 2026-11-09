import { ShoppingBag } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';
import { isAssociationPage } from './associationRoutes';

/**
 * FIRST-TIME HINT - an association's shop. One does not "join" an association (owner, 2026-11-04):
 * one pays a cotisation, in its shop, and becomes a cotisant; only its managers edit the member
 * list. So the hint points at the Shop row of `AssociationDetailView` (`asso.shop`) and says what the
 * shop is for, in the app's own words (cotisation, cotisant, the prices and offers reserved to them).
 *
 * The Shop row is drawn only when the association offers something (`mayOpenPublicSection`), so the
 * audience is any signed-in visitor of an association whose shop is non-empty, and an empty shop
 * leaves the step out (not-rendered). The page loads after the route settles, so the help starts when
 * the row mounts. Short on purpose: one step.
 */
export const associationShopHint: GuideDefinition = {
  id: 'hint-asso-shop',
  kind: 'hint',
  appliesTo: isAssociationPage,
  steps: [
    {
      id: 'shop',
      anchor: 'asso.shop',
      icon: ShoppingBag,
      title: m.guide_hint_asso_shop_title,
      body: m.guide_hint_asso_shop_body,
    },
  ],
};

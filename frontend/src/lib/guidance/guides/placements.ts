import type { GuideLayout, GuidePlacement } from '../guideTypes';

/**
 * The desktop rail is a column at the left edge: a bubble pointing at its entries goes beside it,
 * the phone bar's goes above it. Shared by every help that points at a `nav.<place>` entry.
 */
export const besideTheRail = {
  byLayout: (layout: GuideLayout): GuidePlacement => (layout.phone ? 'auto' : 'right'),
};

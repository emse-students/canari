/**
 * The association routes the batch 3 helps start on. An association's page is
 * `/associations/<slug>`, its management hub `/associations/<slug>/edit`; a section under either is
 * a deeper route a help does not start on (the management help points at the hub's own rows).
 * `new` is the creation page, not an association.
 */
const PUBLIC_PAGE = /^\/associations\/(?!new\/?$)[^/]+\/?$/;
const MANAGEMENT_HUB = /^\/associations\/[^/]+\/edit\/?$/;

/** An association's own page (the hub of its public sections). */
export const isAssociationPage = (pathname: string): boolean => PUBLIC_PAGE.test(pathname);

/** An association's management hub, the list of its management sections. */
export const isAssociationManagementHub = (pathname: string): boolean =>
  MANAGEMENT_HUB.test(pathname);

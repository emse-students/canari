## Product grids: the shared size columns, built - what is still owed is a reading on dev

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

Built (owner, 2026-11-21: "shared size columns for product grids", launch now): a form's priced
grids may name a SHARED COLUMN SET, so the sizes of a shop are typed once and every grid that uses
them follows ([forms](../frontend/modules/forms.md#product-grids-may-share-their-columns-owner-2026-11-21)).
No migration, no data rewrite.

**Owed on dev, as a manager and as a buyer**, once the pre-release carrying it is up: on a form with
three product grids typed with the same sizes, share the columns of the first (the editor offers to
attach the other two), rename a size and add one from any of the three, and see all three change;
remove a size that an answer ordered and read the warning; submit one order across two of the grids
and read the manager's list, the "Articles" and "Totaux" sheets of the export. An older app (`1.7.x`)
must draw the same grids and take the same order.

## P3 - the carte de la vie asso: a complete redesign of the editor, the canvas and the model (owner, 2026-11-08)

target: 1.10.0

The owner wants the carte redesigned as a whole - not only its display: the editor, the canvas and
the data model - LATER, after the per-space change (one map per space, per-map zones, per-association
switches, the one-line action bar) that shipped with migration 147
([carte](../carte-vie-asso.md#a-carte-belongs-to-one-space)).

Not designed yet. What the redesign starts from: the layout is an opaque JSON blob re-validated on
publish, the canvas is a hand-built drag and drop over absolutely placed units, the PDF is a raster
of the on-screen poster (snapdom), and the portail renders a resolved v2 payload whose numbers it
uses verbatim - any change of unit there is a visual break on the other origin
([carte](../carte-vie-asso.md#the-consumer-side)). The first step is the owner's brief: what the new
carte must do that the current one cannot.

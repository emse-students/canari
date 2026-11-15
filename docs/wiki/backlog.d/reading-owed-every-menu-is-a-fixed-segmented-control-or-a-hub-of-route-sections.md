## Reading owed - every menu is a fixed segmented control or a hub of route sections

target: 1.7.0

**What is built:** every menu is a fixed segmented control or a hub of route sections (chantier CLOSED 2026-10-14)

**The reading that closes it:** one look on each phone: a hub, one section, Back and the Android hardware back, a reload on a section ([section-navigation](../frontend/section-navigation.md#closed-2026-10-14---the-final-shape-do-not-reopen))

**Triage 2026-11-14: Mi 9T about 10 min, iPhone about 10 min.**

**iPhone 12 half, READ 2026-11-15** (TestFlight `1.6.12-alpha.2`, dev): the hub opens from its tab, each section (Institutions, Boutique, Formulaires, Reservations, Jeux, Notifs) opens as a page of its own and the tab returns to the hub; on the profile hub a section ("A propos de moi") shows the Back arrow ("Retour : Mon profil") and the arrow returns to the hub; a cold start on a section lands on the feed after the PIN, which is the app's own entry and not a reload of a route. A WDA edge swipe from x=2 did not go back on a section; it is not a Back path the design names, so it is not read as a defect. Left: the Mi 9T look and the Android hardware back.

**iPhone 12, second look 2026-11-15** (same build): the dashboard hub, Parametres, Preferences and Sauvegarde read again, the crumb arrow ("Retour : Parametres") returns to the hub from both sections, and a second WDA edge swipe on a section (three starts, x = 0 to 2, 150 to 500 ms) again changed nothing: the iOS shell sets no back-forward navigation gesture, so the crumb is the Back there. The Theme segmented control reads whole; the Emojis row beside it does not ([defect](p3-the-emojis-preference-row-squeezes-its-description-on-a-phone.md)). The Android hardware back and a reload on a section stay for the Mi 9T.

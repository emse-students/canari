## Reading owed - the feed on an iPhone below iOS 26 (the classic tab bar), dark mode

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

**Why.** The owner's report of 2026-11-22 (a user's iPhone without Liquid Glass, dark mode) showed a
black band between the header and the tab pill, the first tab clipped and a gap above an opaque bottom
bar. Its tab labels date the build to `1.6.0`-`1.6.8`; the band and the clipping were fixed in `1.6.9`
for every phone, and the classic bar's reserve is the plugin's measured inset
([design-reference](../frontend/design-reference.md)). All of that was measured in a desktop Chrome
with the classic bar and the opaque fallback SIMULATED - no iPhone below iOS 26 has run a current build.

**The reading**, on any iPhone on iOS 16-25 with the current pre-release, dark mode, `/posts`:
1. at the top of the feed, the tab pill sits about 8 pt under the header, with no empty band;
2. the three tabs and the CanaReels button are all in view, none clipped at either edge;
3. scrolling, the cards run under the classic bar down to the screen's edge, with no dark strip
   between the last visible card and the bar; at the very end, the gap above the bar is the column's
   ordinary bottom margin (24 pt);
4. the `[NativeTabBar] bottom inset` log line reads the bar's height plus the home-indicator strip
   (83 on a notched iPhone, 49 on one with a home button).

A FAIL on 3 or 4 names the plugin's `bottomInset` on the classic bar; a FAIL on 1 or 2 names the feed.

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** The bench iPhone 12 runs iOS 26, so the classic bar never draws on it: the reading needs an iPhone on iOS 16 to 25, which only a human hand can bring. Asked of the owner; with no such phone, this entry closes on the simulated Chrome measurement already taken.

## P3 - Read the usage page's line charts and headline figures on dev

target: 1.8.3

`/admin/usage` gained, on 2026-11-26 (owner feedback: *"j'aimais bien les graphiques d'avant aussi, et les ordres de grandeurs journee/semaine/mois"*), the shared line chart and a headline with the last complete period
([usage dashboard](../usage-dashboard.md#the-page-adminusage)). It was proved on seeded data at 1280 and 390 px, never on the real figures.

### What is owed

On a pre-release of `1.8.3`, open `/admin/usage` as a platform admin on a laptop and on a phone, and check that:
- the three tiles and the "average per day" line read as orders of magnitude, with yesterday, last week and last month beside them (a period the server has no row for says "not counted", never a zero);
- the two line charts (device type, version) show a line per type and version that had people, the dashed total, a readout under the finger, and a blank day as a gap;
- the 7, 30 and 90 day buttons move the bars and both charts together.

Delete this file once read.

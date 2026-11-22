## P3 - i18n: the English chat list shows a French system preview ("...a ajouté ... au groupe") (S17, 2026-11-20)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Read in sitting S17 of 2026-11-20: with the app in English, the chat list's last-message preview of a member addition reads in French ("X a ajouté Y au groupe"). The preview is built from a stored or system text instead of a Paraglide message in the reader's language. Build it at display time from a message key and the names (user-visible strings use Paraglide on the first draft), and check the other system previews (rename, leave, removal) for the same defect. Context: [history-reconciliation](../protocols/history-reconciliation.md).

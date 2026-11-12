## P3 - A new-device alert outlives the device it announces (Mi 9T, 2026-10-28)

Read on the Mi 9T's bench account after a reinstall: a queue of "Nouvel appareil sur votre compte"
alerts, one per enrolment of the account's other clients. Three findings were filed. Two are moot
since #2770 (2026-10-30, the owner's decision to have no banner for device notices): the alert is a
row of `/notifications` (`DeviceNoticeRow.svelte`), so it neither queues one at a time (the list
shows every row, and opening it reads them all, `markDeviceNoticesRead`) nor covers the CanaReels
camera (`NewDeviceBanner.svelte` is deleted).

**What is left: nothing removes a pending alert whose device has since left the account.** A row
goes on "Compris", on "Ce n'est pas moi" (`revokeNoticedDevice`) or on the devices link, never on
the device's revocation elsewhere, so a reinstall can list devices that no longer exist.

**Plan (batch 16, 2026-11-12), one small PR, no agent needed.** The drop needs a FACT that the
device left, never an age: (1) the account's device list, the answer `/settings/security` already
reads (`DeviceManagementPanel.svelte`): a successful answer that does not name a notice's `deviceId`
drops that notice, logged `[DEVICE_NOTICE] alert dropped: <id> is no longer on the account`; a
failed read drops nothing (a transport failure is not an answer). (2) Call it where the list is read
and when `/notifications` opens. Tests in `deviceNotices.svelte.test.ts`: an answer without the
device drops its notice and only it; a failed read keeps every notice; this device's own id is never
read as gone. Then one Mi 9T reading: revoke a device from another client, open the list, the row is
gone.

/**
 * What an account erasure does to every column of this service that can name an account.
 *
 * THE LIST IS THE CONTRACT, AND `account-erasure-coverage.spec.ts` READS THE ENTITIES TO HOLD IT.
 * The erasure handler (`InternalController.deleteUserData`) used to be a hand-written set of
 * deletes, and four tables (`device_signature_key`, `notification_preference`,
 * `dm_user_dismissed_groups`, the queued messages an account SENT) were simply never named - a
 * table added later is invisible to a list nobody re-reads. The spec scans every `*.entity.ts` for
 * a column whose name says it holds an account id and fails until that column has a disposition
 * here, so a new one cannot ship unclassified.
 *
 * `delete` - the rows go. `anonymise` - the row stays for the people it also belongs to, and the
 * account id is replaced by {@link DELETED_ACCOUNT}. `kept` - deliberately untouched, with the
 * reason, which is the only disposition that needs one; a `delete` that spares some rows says which
 * in `except`.
 */
export type ErasureDisposition =
  | { action: 'delete'; except?: string }
  | { action: 'anonymise' }
  | { action: 'kept'; reason: string };

/** The account id written in place of an erased one. The same spelling social-service uses. */
export const DELETED_ACCOUNT = '[deleted]';

/** `Entity.column` -> what the erasure does to it. */
export const ACCOUNT_ERASURE_COVERAGE: Record<string, ErasureDisposition> = {
  'DeviceGroupMembership.userId': { action: 'delete' },
  'DeviceSignatureKey.userId': { action: 'delete' },
  'Group.createdBy': { action: 'anonymise' },
  'GroupInvite.createdBy': { action: 'anonymise' },
  'GroupMember.userId': { action: 'delete' },
  'GroupMembershipInterval.userId': { action: 'delete' },
  'KeyPackage.userId': { action: 'delete' },
  'MlsCommitLog.senderDeviceId': {
    action: 'kept',
    reason:
      'a device id inside the commit history of a group other members still use; the log is ' +
      'theirs, bounded by its own retention, and replaying it needs the sender',
  },
  'NotificationPreference.userId': { action: 'delete' },
  'OneTimeKeyPackage.userId': { action: 'delete' },
  'PinVerifier.userId': { action: 'delete' },
  'PushToken.userId': { action: 'delete' },
  'QueuedMessage.recipientId': { action: 'delete' },
  'QueuedMessage.senderId': {
    action: 'delete',
    except:
      'a queued commit or Welcome: the recipients protocol state, deleted when it is delivered',
  },
  'QueuedMessage.senderDeviceId': {
    action: 'kept',
    reason:
      'only on a queued HANDSHAKE frame once the application messages are gone - a commit or a ' +
      'Welcome is the recipients protocol state and leaves the queue when it is delivered',
  },
  'RevokedDevice.userId': { action: 'delete' },
  'SeatEviction.userId': { action: 'delete' },
  'JoinAskPush.userId': { action: 'delete' },
  'RevokedDeviceGroup.userId': { action: 'delete' },
  'UserDismissedGroup.userId': { action: 'delete' },
};

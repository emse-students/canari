#import "canari_push.h"
#import "canari_ios.h"
#import "canari_rust_bridge.h"
#import "KeyboardMediaBridge.h"

#import <CallKit/CallKit.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <PushKit/PushKit.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <WebKit/WebKit.h>

#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
#import <FirebaseMessaging/FirebaseMessaging.h>
#endif

#if __has_include(<BackgroundTasks/BackgroundTasks.h>)
#import <BackgroundTasks/BackgroundTasks.h>
#endif

static NSString *const kPushSecretKeychainService = @"canari_push_secret";
static NSString *const kPushSecretKeychainAccount = @"push_secret";
static NSString *const kCanariBundleId = @"fr.emse.canari";
static NSString *const kPendingPushSecretFileName = @"pending_push_secret.txt";
static NSString *const kPushContextFileName = @"push_context.json";
static NSString *const kMlsBinFileName = @"mls.bin";
static NSString *const kFcmCacheFileName = @"fcm_message_cache.ndjson";
/// Cross-process hand-off: what the notification shade acknowledged while the app was not running.
/// Read and cleared by the `read_and_clear_read_watermarks` Tauri command. Android twin: the same
/// name in CanariFirebaseMessagingService.appendReadWatermark.
static NSString *const kReadWatermarkFileName = @"read_watermarks.ndjson";
static const NSUInteger kMaxFcmCacheEntries = 50;
static const int kWelcomeRaceRetries = 3;
static const useconds_t kWelcomeRaceRetryDelayUs = 1800000;
/// The initials disc drawn when no avatar can be fetched - see CanariInitialsImagePath. Twins of
/// Android's generateInitialsBitmap (96 px there; an attachment is shown larger than a large icon)
/// and of NotificationService.swift's own copy, which the appex cannot share.
static const CGFloat kCanariInitialsSize = 192;
static const CGFloat kCanariInitialsLetterRatio = 0.4;
static NSString *const kOutboxPendingFileName = @"outbox_pending.ndjson";

/// A log-safe summary of a deep link: scheme + host, the first path segment on an http(s) link
/// only (on a custom scheme the host IS the route and the first segment is already an id), and
/// whether a query or fragment was present. Never an id, a token or a parameter value. Twin of
/// `describeDeepLink` in frontend/src/lib/utils/logSanitize.ts.
static NSString *CanariDescribeDeepLink(NSString *deepLink) {
  NSURLComponents *c = [NSURLComponents componentsWithString:deepLink];
  if (c == nil || c.scheme.length == 0) {
    return @"[unparseable deep link]";
  }
  BOOL web = [c.scheme isEqualToString:@"https"] || [c.scheme isEqualToString:@"http"];
  NSMutableString *out = [NSMutableString stringWithFormat:@"%@://%@", c.scheme, c.host ?: @""];
  NSMutableArray<NSString *> *segments = [NSMutableArray array];
  for (NSString *seg in [c.path componentsSeparatedByString:@"/"]) {
    if (seg.length > 0) [segments addObject:seg];
  }
  if (segments.count > 0) {
    if (web) {
      [out appendFormat:@"/%@%@", segments[0], segments.count > 1 ? @"/..." : @""];
    } else {
      [out appendFormat:@"/[%lu seg]", (unsigned long)segments.count];
    }
  }
  if (c.query.length > 0) [out appendString:@" +query"];
  if (c.fragment.length > 0) [out appendString:@" +fragment"];
  return out;
}

/// The id a chat link may carry: `^[A-Za-z0-9_-]{1,128}$` - every group id (a UUID) and every
/// channel id fits it. Twin of `NotificationService.isLinkId`.
static BOOL CanariIsLinkId(NSString *_Nullable value) {
  static NSRegularExpression *re;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    re = [NSRegularExpression regularExpressionWithPattern:@"^[A-Za-z0-9_-]{1,128}$" options:0 error:nil];
  });
  return value != nil &&
         [re numberOfMatchesInString:value options:0 range:NSMakeRange(0, value.length)] == 1;
}

/// THE ONE PLACE A CHAT LINK IS BUILT FROM AN ID (`fr.emse.canari://chat/<prefix><id>`), and only
/// when the id is an id: a value carrying `/`, `?`, `#` or `..` would otherwise open another route
/// than the conversation. Nil, logged with its length only, on a mismatch. Twin of the extension's
/// `NotificationService.chatLink`.
static NSString *_Nullable CanariChatLink(NSString *_Nullable value, NSString *prefix) {
  if (!CanariIsLinkId(value)) {
    NSLog(@"[CanariPush] chat link refused: the id is not an id (length=%lu)",
          (unsigned long)value.length);
    return nil;
  }
  return [NSString stringWithFormat:@"fr.emse.canari://chat/%@%@", prefix, value];
}

/// The link a tap on a notification opens: the payload's own `deepLink` when it is one of this
/// app's (`fr.emse.canari:` - a payload naming another scheme would have the app open whatever it
/// names), else the conversation its CLEARTEXT fields name.
///
/// THE TAP TARGET MUST NOT SIT BEHIND THE DECRYPT. A message or salon push carries no `deepLink`
/// from the server; the Notification Service Extension writes `chat/<groupId>` (or
/// `chat/channel_<id>`) when it runs. When it does not - killed for memory, out of time, or not
/// loadable on the phone's iOS - the banner is the server's generic one AND the tap opened the app
/// on nothing, though `groupId` / `channelId` were in the payload all along (P1 of 2026-11-01). The
/// same strings as the extension's, so both paths land identically. Nil when nothing names a target.
static NSString *_Nullable CanariTapDeepLink(NSDictionary *userInfo) {
  id link = userInfo[@"deepLink"];
  if ([link isKindOfClass:[NSString class]] && [(NSString *)link length] > 0) {
    NSURLComponents *c = [NSURLComponents componentsWithString:link];
    if ([c.scheme isEqualToString:@"fr.emse.canari"]) {
      return link;
    }
    NSLog(@"[CanariPush] notification tap: the payload's deepLink is not this app's (%@) - ignored",
          CanariDescribeDeepLink(link));
  }
  NSString *type = [userInfo[@"type"] isKindOfClass:[NSString class]] ? userInfo[@"type"] : @"message";
  if ([type isEqualToString:@"channel"]) {
    NSString *channelId =
        [userInfo[@"channelId"] isKindOfClass:[NSString class]] ? userInfo[@"channelId"] : @"";
    if (channelId.length > 0) {
      NSLog(@"[CanariPush] notification tap: no deepLink - the salon named in clear is opened");
      return CanariChatLink(channelId, @"channel_");
    }
  } else if ([type isEqualToString:@"message"]) {
    NSString *groupId =
        [userInfo[@"groupId"] isKindOfClass:[NSString class]] ? userInfo[@"groupId"] : @"";
    if (groupId.length > 0) {
      NSLog(@"[CanariPush] notification tap: no deepLink - the conversation named in clear is opened");
      return CanariChatLink(groupId, @"");
    }
  }
  return nil;
}


static NSString *const kOutboxSentFileName = @"outbox_sent.ndjson";
// How many queued messages one drain ATTEMPTS. The cap is on the ENCRYPT, deliberately: encrypting
// consumes a ratchet generation whether or not the frame is ever POSTed, so encrypting a backlog
// the drain has no time to deliver would run this sender's generation far ahead of what the peer
// receives - eventually past OpenMLS's maximum forward distance, which no retry can repair.
// Whatever is left over is not touched at all and is drained next time, so a backlog of any size
// converges across successive drains. The native side applies it, so that a group held behind an
// unsettled staged commit takes none of the slots. Android twin: DRAIN_MAX_BATCH.
static const NSUInteger kCanariDrainMaxBatch = 100;
// Wall-clock budget for the POST half of an outbox drain. The OS reclaims a background task
// whatever it is doing, and the drain also pays for the batch encrypt before it gets here.
// Exceeding it is not an error - the remainder stays queued - but unlike the batch cap it does
// leave already encrypted frames unsent, so it is the safety net for a slow network rather than the
// normal exit. Android twin: DRAIN_POST_BUDGET_MS.
static const NSTimeInterval kCanariDrainPostBudgetMs = 35000.0;
// How many deliveries may accumulate before the mirror is rewritten. The mirror is the only record
// of what is still owed, so between two rewrites a hard kill re-sends everything already delivered
// - this bounds that window instead of letting it be the whole backlog.
static const NSUInteger kCanariDrainCheckpointEvery = 25;
// BGProcessingTask identifier; MUST match BGTaskSchedulerPermittedIdentifiers in Info.plist.
// iOS analogue of Android's expedited MlsBackgroundWorker (WorkManager): given a background
// window by the OS, it drains mls_pending.db via canari_native_cleanup_pending_db.
static NSString *const kCanariBgCleanupTaskId = @"fr.emse.canari.cleanup";
// WP-XP-8: deferred outbox retry. When the opportunistic drain (FCM / Welcome / boot) leaves
// messages unsent, this BGProcessingTask retries with the OS's own scheduling cadence (iOS
// analogue of Android's OutboxRetryWorker). Requires network connectivity.
static NSString *const kCanariBgOutboxRetryTaskId = @"fr.emse.canari.outboxRetry";
static const int kPendingSyncNotifId = 9998;
static const NSTimeInterval kAvatarCacheMaxAgeSec = 24 * 60 * 60;

// Notification quick actions (WP-XP-1): inline reply / mark as read from the notification.
static NSString *const kCanariMessageCategoryId = @"canari_message_category";
static NSString *const kCanariReplyActionId = @"CANARI_REPLY_ACTION";
static NSString *const kCanariMarkReadActionId = @"CANARI_MARK_READ_ACTION";
static NSString *const kFcmCacheGroupIdKey = @"groupId";
static NSString *const kFcmCacheMessageIdKey = @"messageId";

/// Serializes decrypt attempts against `mls.bin` WITHIN THIS PROCESS (app) only - unlike
/// Android's `MlsStateLock`, which is shared between two components that run in the same
/// process, this has no peer to coordinate with: the Notification Service Extension runs in a
/// SEPARATE process and cannot see this NSLock (docs/wiki/frontend/android-ios-parity.md#2.3).
/// That is safe, not merely assumed, because both halves of the claim are true and enforced
/// elsewhere: the NSE's decrypt path is read-only (NotificationService.swift's file-level
/// comment: "the extension never writes mls.bin"), and the app's own write - the App Group
/// mirror `CanariMirrorPushStateToAppGroup` produces below - uses `NSDataWritingAtomic`
/// (temp file + rename), so a concurrent NSE read can never observe a torn file. If either half
/// ever stops holding, this lock stops being sufficient and the fix belongs at THAT half, not
/// here.
static NSLock *g_mlsStateLock = nil;
static NSLock *g_cacheLock = nil;

@interface CanariPushContext : NSObject
@property(nonatomic, copy) NSString *deviceKeyB64;
@property(nonatomic, copy) NSString *userId;
@property(nonatomic, copy) NSString *deviceId;
@property(nonatomic, copy) NSString *baseUrl;
/// The language CHOSEN IN THE APP ("fr" / "en"), mirrored from the WebView, which is not running
/// when a push arrives. NOT `preferredLocalizations`, which answers for the OS and would make an
/// app set to English on a French phone write French notifications. Empty until first mirrored.
@property(nonatomic, copy) NSString *locale;
@end

@implementation CanariPushContext
@end

@interface CanariDecryptedMessage : NSObject
@property(nonatomic, copy) NSString *text;
@property(nonatomic, copy) NSString *messageId;
@property(nonatomic, assign) long long sentAt;
@property(nonatomic, copy) NSString *type;
// "image" | "video" | "audio" | "file" | "reel", as Rust read it. "reel" is a CanaReel sent in a
// conversation (WP-RC-7): Rust words its line and withholds its key, so
// CanariFetchAndDecryptMedia returns nil for it - no thumbnail, ever.
@property(nonatomic, copy, nullable) NSString *mediaKind;
// Media reference + CEK (WP-XP-3), populated only for a media message. Used to download and
// AES-256-GCM-decrypt the blob for a notification thumbnail. nil for non-media messages.
@property(nonatomic, copy, nullable) NSString *mediaId;
@property(nonatomic, copy, nullable) NSString *mediaKey;
@property(nonatomic, copy, nullable) NSString *mediaIv;
@property(nonatomic, copy, nullable) NSString *mimeType;
// Call signaling (WP-XP-5), populated only for `type == "call_invite" | "call_control"`.
@property(nonatomic, copy, nullable) NSString *callId;
@property(nonatomic, assign) BOOL callEnded;
@property(nonatomic, assign) BOOL hasVideo;
@end

@implementation CanariDecryptedMessage
@end

/// Copies the media reference/CEK fields (WP-XP-3) from a decrypt-result JSON dict onto `msg`.
/// Shared by both decrypt parsers (direct + commit catch-up).
static void CanariPopulateMediaFields(CanariDecryptedMessage *msg, NSDictionary *dict) {
  id kind = dict[@"mediaKind"];
  msg.mediaKind = [kind isKindOfClass:[NSString class]] ? kind : nil;
  id mediaId = dict[@"mediaId"];
  msg.mediaId = [mediaId isKindOfClass:[NSString class]] ? mediaId : nil;
  id mediaKey = dict[@"mediaKey"];
  msg.mediaKey = [mediaKey isKindOfClass:[NSString class]] ? mediaKey : nil;
  id mediaIv = dict[@"mediaIv"];
  msg.mediaIv = [mediaIv isKindOfClass:[NSString class]] ? mediaIv : nil;
  id mimeType = dict[@"mimeType"];
  msg.mimeType = [mimeType isKindOfClass:[NSString class]] ? mimeType : nil;
}

/// Parses a decrypt-result JSON string (extract_full_message_info shape) into a
/// CanariDecryptedMessage. Shared by the direct and commit-catch-up decrypt paths (was
/// duplicated in both). Call signaling (WP-XP-5) legitimately has an empty text
/// ("call_control"); every other type without a preview is unrenderable -> nil.
static CanariDecryptedMessage *_Nullable CanariParseDecryptedJson(NSString *jsonStr) {
  if (jsonStr.length == 0) {
    return nil;
  }
  NSData *jsonData = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
  id json = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
  if (![json isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  NSDictionary *dict = (NSDictionary *)json;
  if (![dict[@"ok"] boolValue]) {
    return nil;
  }
  NSString *type = [dict[@"type"] isKindOfClass:[NSString class]] ? dict[@"type"] : @"text";
  BOOL isCall = [type isEqualToString:@"call_invite"] || [type isEqualToString:@"call_control"];
  NSString *text = [dict[@"text"] isKindOfClass:[NSString class]] ? dict[@"text"] : @"";
  if (text.length == 0 && !isCall) {
    return nil;
  }
  CanariDecryptedMessage *msg = [[CanariDecryptedMessage alloc] init];
  if (text.length > 200) {
    text = [text substringToIndex:200];
  }
  msg.text = text;
  msg.messageId = [dict[@"messageId"] isKindOfClass:[NSString class]] ? dict[@"messageId"] : @"";
  msg.sentAt = [dict[@"sentAt"] respondsToSelector:@selector(longLongValue)]
                   ? [dict[@"sentAt"] longLongValue]
                   : (long long)([[NSDate date] timeIntervalSince1970] * 1000);
  msg.type = type;
  msg.callId = [dict[@"callId"] isKindOfClass:[NSString class]] ? dict[@"callId"] : nil;
  msg.callEnded = [dict[@"callEnded"] boolValue];
  msg.hasVideo = [dict[@"hasVideo"] boolValue];
  CanariPopulateMediaFields(msg, dict);
  return msg;
}

@interface CanariOutboxEntry : NSObject
@property(nonatomic, copy) NSString *entryId;
@property(nonatomic, copy) NSString *groupId;
@property(nonatomic, copy) NSString *proto;
@property(nonatomic, assign) long long sentAt;
@property(nonatomic, assign) BOOL silent;
/**
 * Append to the group's shared log. Independent of `silent`, and true for every outbox entry: a
 * mutation sent from the background must be as durable as one sent from the foreground, or which
 * path delivered it would decide whether an absent device can ever learn about it.
 */
@property(nonatomic, assign) BOOL durable;
@end

@implementation CanariOutboxEntry
@end

NSString *CanariTauriDataDir(void) {
  NSArray<NSString *> *paths = NSSearchPathForDirectoriesInDomains(
      NSApplicationSupportDirectory, NSUserDomainMask, YES);
  NSString *base = paths.firstObject;
  if (base == nil) {
    return nil;
  }
  NSString *dir = [base stringByAppendingPathComponent:kCanariBundleId];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir
                          withIntermediateDirectories:YES
                                           attributes:nil
                                                error:nil];
  return dir;
}

NSString *CanariTauriCacheDir(void) {
  NSArray<NSString *> *paths =
      NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
  NSString *base = paths.firstObject;
  if (base == nil) {
    return nil;
  }
  return [base stringByAppendingPathComponent:kCanariBundleId];
}

// The two sign-out marks - names shared with `push_registration.rs` and `PushRegistrationEnd.kt`;
// change all three together. Why two, and who removes each: the head of `push_registration.rs`.
static NSString *const kPushSignedOutFileName = @"push_signed_out";
static NSString *const kPushTokenDeletionOwedFileName = @"push_token_deletion_owed";

static BOOL CanariPushMarkExists(NSString *name) {
  NSString *dir = CanariTauriDataDir();
  return dir != nil &&
         [[NSFileManager defaultManager] fileExistsAtPath:[dir stringByAppendingPathComponent:name]];
}

/// True while no account owns this device's pushes: a push that still arrives is not shown.
static BOOL CanariPushSignedOut(void) { return CanariPushMarkExists(kPushSignedOutFileName); }

/// True while the FCM token of the account that signed out has not been deleted.
static BOOL CanariPushTokenDeletionOwed(void) {
  return CanariPushMarkExists(kPushTokenDeletionOwedFileName);
}

/// Erases the Keychain copy of the push secret: a sign-out ends the registration it authenticated.
static void CanariPushSecretErase(void) {
  NSDictionary *query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : kPushSecretKeychainService,
    (__bridge id)kSecAttrAccount : kPushSecretKeychainAccount,
  };
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
  if (status != errSecSuccess && status != errSecItemNotFound) {
    NSLog(@"[CanariPush] ERROR: the push secret was NOT erased from the Keychain (status %d)",
          (int)status);
  }
}

static bool CanariPushSecretStore(NSString *secret) {
  if (secret.length == 0) {
    return false;
  }
  NSData *secretData = [secret dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : kPushSecretKeychainService,
    (__bridge id)kSecAttrAccount : kPushSecretKeychainAccount,
  };
  SecItemDelete((__bridge CFDictionaryRef)query);
  NSMutableDictionary *add = [query mutableCopy];
  add[(__bridge id)kSecValueData] = secretData;
  add[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
  return SecItemAdd((__bridge CFDictionaryRef)add, nil) == errSecSuccess;
}

// pending_push_secret.txt WINS over the Keychain whenever it exists, because it is newer by
// construction: POST /mls/push/register mints a fresh secret on EVERY call and invalidates the
// previous one server-side, the WebView writes that secret to the file (store_push_secret), and
// the only thing that ever moves the file into the Keychain is this function - reached at process
// start, i.e. strictly BEFORE the registration that wrote the file.
//
// Reading the Keychain first therefore returned the PREVIOUS process's secret for the whole life
// of a process, and the server answered 403 to every background send made from a merely
// backgrounded app. Measured on Android, where the code and the server behaviour are the same
// (WP-NOTIF-1); this is the same defect in the mirrored implementation and is UNPROVEN on iOS
// hardware - see check S in docs/wiki/device-verification.md.
NSString *CanariRetrievePushSecret(void) {
  NSString *dir = CanariTauriDataDir();
  NSString *path =
      dir == nil ? nil : [dir stringByAppendingPathComponent:kPendingPushSecretFileName];
  if (path != nil && [[NSFileManager defaultManager] fileExistsAtPath:path]) {
    NSData *raw = [NSData dataWithContentsOfFile:path];
    NSString *secret =
        raw == nil ? nil
                   : [[[NSString alloc] initWithData:raw encoding:NSUTF8StringEncoding]
                         stringByTrimmingCharactersInSet:[NSCharacterSet
                                                             whitespaceAndNewlineCharacterSet]];
    if (secret.length > 0) {
      CanariPushSecretStore(secret);
      NSMutableData *zeros = [NSMutableData dataWithLength:raw.length];
      [zeros writeToFile:path atomically:YES];
      [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
      NSLog(@"[CanariPush] newer secret adopted from pending_push_secret.txt");
      return secret;
    }
    // An empty/unreadable file is a half-written handoff, not an answer: leave it for the next
    // reader and fall through to the Keychain rather than deleting a secret nobody has read yet.
    NSLog(@"[CanariPush] pending_push_secret.txt present but empty - reading the Keychain");
  }

  NSDictionary *query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : kPushSecretKeychainService,
    (__bridge id)kSecAttrAccount : kPushSecretKeychainAccount,
    (__bridge id)kSecReturnData : @YES,
    (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitOne,
  };
  CFTypeRef item = nil;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &item) == errSecSuccess && item != nil) {
    NSData *data = (__bridge_transfer NSData *)item;
    NSString *stored = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (stored.length > 0) {
      return stored;
    }
  }
  NSLog(@"[CanariPush] no secret: neither a pending file nor the Keychain holds one - background "
        @"sends impossible");
  return nil;
}

// WP-SEC-1: retrieves the MLS device key from the background-accessible Keychain item
// (AfterFirstUnlockThisDeviceOnly, no .userPresence, shared via group.fr.emse.canari).
// Returns the base64-encoded key, or nil if absent. Mirrored by the Swift twin in
// NotificationService.swift.
static NSString *_Nullable CanariRetrieveDeviceKey(NSString *userId, NSString *deviceId) {
  if (userId.length == 0 || deviceId.length == 0) {
    return nil;
  }
  NSString *alias = [NSString stringWithFormat:@"mls_device_key_%@_%@", userId, deviceId];
  NSString *account = [NSString stringWithFormat:@"mls_bg_key_%@", alias];
  NSDictionary *query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @"fr.emse.canari",
    (__bridge id)kSecAttrAccount : account,
    (__bridge id)kSecReturnData : @YES,
    (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitOne,
  };
  CFTypeRef item = nil;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &item) == errSecSuccess && item != nil) {
    NSData *data = (__bridge_transfer NSData *)item;
    if (data.length > 0) {
      // RAW key bytes, not text - storeKeyBytes base64-decodes before writing. See the
      // Swift twin in NotificationService.retrieveDeviceKey.
      return [data base64EncodedStringWithOptions:0];
    }
  }
  return nil;
}

// The install's native cache key (Rust `native_cache`), base64, from the shared Keychain item
// `CanariEnsureNativeCacheKey` creates at bootstrap. @"" when absent or unreadable - which Rust
// treats as "write nothing, read nothing sealed", never as a reason to write in the clear.
// Swift twin: NotificationService.retrieveNativeCacheKey.
static NSString *CanariRetrieveNativeCacheKey(void) {
  NSDictionary *query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @"fr.emse.canari",
    (__bridge id)kSecAttrAccount : @"mls_bg_key_canari_native_cache_key",
    (__bridge id)kSecAttrAccessGroup : @"group.fr.emse.canari",
    (__bridge id)kSecReturnData : @YES,
    (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitOne,
  };
  CFTypeRef item = nil;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &item);
  if (status == errSecSuccess && item != nil) {
    NSData *data = (__bridge_transfer NSData *)item;
    if (data.length == 32) {
      // RAW key bytes, re-encoded - never read as UTF-8.
      return [data base64EncodedStringWithOptions:0];
    }
  }
  NSLog(@"[CanariPush] native cache key: ERROR unreadable (status=%d)", (int)status);
  return @"";
}

static CanariPushContext *_Nullable CanariLoadPushContext(void) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return nil;
  }
  NSString *path = [dir stringByAppendingPathComponent:kPushContextFileName];
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (data == nil) {
    return nil;
  }
  id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![json isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  NSDictionary *dict = (NSDictionary *)json;
  NSString *userId = [dict[@"userId"] isKindOfClass:[NSString class]] ? dict[@"userId"] : @"";
  NSString *deviceId = [dict[@"deviceId"] isKindOfClass:[NSString class]] ? dict[@"deviceId"] : @"";
  NSString *baseUrl = [dict[@"baseUrl"] isKindOfClass:[NSString class]] ? dict[@"baseUrl"] : @"";
  if (userId.length == 0 || deviceId.length == 0 || baseUrl.length == 0) {
    return nil;
  }
  // WP-SEC-1: the device key is no longer in the JSON; source it from the Keychain.
  // Ordering constraint: the account name needs userId + deviceId from the JSON, so
  // parse the JSON first, then hit the Keychain. An empty key means the Keychain is
  // unavailable — the push falls back to the generic text, but that is the acceptable
  // one-push cost (see B5 migration).
  NSString *deviceKeyB64 = CanariRetrieveDeviceKey(userId, deviceId) ?: @"";
  CanariPushContext *ctx = [[CanariPushContext alloc] init];
  ctx.deviceKeyB64 = deviceKeyB64;
  ctx.locale = [dict[@"locale"] isKindOfClass:[NSString class]] ? dict[@"locale"] : @"";
  ctx.userId = userId;
  ctx.deviceId = deviceId;
  ctx.baseUrl = baseUrl;
  return ctx;
}

static NSData *_Nullable CanariLoadMlsState(void) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return nil;
  }
  return [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:kMlsBinFileName]];
}

static NSString *const kAppGroupId = @"group.fr.emse.canari";
static NSString *const kGraineSeedsFileName = @"graine_seeds.json";
static NSString *const kAppGroupPushSecretFileName = @"push_secret.txt";

void CanariMirrorPushStateToAppGroup(void) {
  NSURL *container = [[NSFileManager defaultManager]
      containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
  if (container == nil) {
    NSLog(@"[CanariPush] mirror: App Group unavailable (missing entitlement?)");
    return;
  }
  NSString *src = CanariTauriDataDir();
  if (src == nil) {
    return;
  }
  // The Notification Service Extension reads these three inputs to decrypt a push in its
  // own process. Write atomically (temp + rename) so the cross-process reader never sees a
  // torn file, and keep the same at-rest protection class as the source.
  NSDataWritingOptions opts =
      NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication;
  for (NSString *name in @[ kMlsBinFileName, kPushContextFileName, kGraineSeedsFileName ]) {
    NSData *data = [NSData dataWithContentsOfFile:[src stringByAppendingPathComponent:name]];
    if (data == nil) {
      continue;
    }
    NSError *err = nil;
    if (![data writeToURL:[container URLByAppendingPathComponent:name] options:opts error:&err]) {
      NSLog(@"[CanariPush] mirror %@ failed: %@", name, CanariErrorReason(err));
    }
  }
  // The push secret lives in the Keychain (app-only). Copy it into the container so the NSE
  // can authenticate the backend fetch paths (omitted proto, commit catch-up, avatar); the
  // common inline-ciphertext decrypt needs no secret. This is NOT the copy's main writer:
  // `store_push_secret` (push.rs) writes it the moment /register rotates the secret, which is
  // after didBecomeActive's mirror - this rewrite only carries the same newest value again.
  // A signed-out device has no secret by design (the sign-out erased it), so it is not looked for:
  // that lookup's "no secret" line is a fault report, and here it would report the sign-out.
  NSString *secret = CanariPushSignedOut() ? nil : CanariRetrievePushSecret();
  if (secret.length > 0) {
    [[secret dataUsingEncoding:NSUTF8StringEncoding]
        writeToURL:[container URLByAppendingPathComponent:kAppGroupPushSecretFileName]
           options:opts
             error:nil];
  }
  CanariExcludeNativeCacheFilesFromBackup(container.path);
  NSLog(@"[CanariPush] mirror to App Group done");
}

void CanariExcludeNativeCacheFilesFromBackup(NSString *_Nullable dir) {
  if (dir == nil) {
    NSLog(@"[CanariPush] backupExclusion: directory unavailable");
    return;
  }
  NSError *listErr = nil;
  NSArray<NSString *> *names = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir
                                                                                   error:&listErr];
  if (names == nil) {
    NSLog(@"[CanariPush] backupExclusion: ERROR %@ not listed: %@", dir.lastPathComponent,
          CanariErrorReason(listErr));
    return;
  }
  NSUInteger excluded = 0;
  for (NSString *name in names) {
    BOOL isCache = [name isEqualToString:kGraineSeedsFileName] ||
                   ([name hasPrefix:@"fcm_message_cache"] && [name hasSuffix:@".ndjson"]);
    if (!isCache) {
      continue;
    }
    NSURL *url = [NSURL fileURLWithPath:[dir stringByAppendingPathComponent:name] isDirectory:NO];
    NSError *err = nil;
    if ([url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&err]) {
      excluded++;
    } else {
      NSLog(@"[CanariPush] backupExclusion: ERROR %@ not excluded: %@", name,
            CanariErrorReason(err));
    }
  }
  NSLog(@"[CanariPush] backupExclusion: %lu cache file(s) excluded in %@", (unsigned long)excluded,
        dir.lastPathComponent);
}

/**
 * The `.lproj` bundle for the language chosen INSIDE Canari, not the one the OS is set to.
 *
 * THOSE ARE TWO DIFFERENT SETTINGS, and only one of them is the user's answer about this app: an
 * app set to English on a French phone was writing French. `NSLocalizedString` answers for the OS
 * and is therefore the wrong call everywhere in this file - hence this indirection rather than the
 * idiomatic macro. The language is mirrored into `push_context.json` by the web layer whenever it
 * changes (`set_push_context_locale`), which is the only moment anything native can learn it.
 *
 * Falls back to the main bundle, which is French-first, when nothing has been mirrored yet (a
 * device that has not opened the app since this shipped) or when the tag names no table we ship.
 * `fr-FR` is tried as `fr` before giving up.
 */
static NSBundle *CanariLocaleBundle(void) {
  CanariPushContext *ctx = CanariLoadPushContext();
  NSString *lang = (ctx.locale.length > 0) ? ctx.locale : nil;
  if (lang == nil) {
    return [NSBundle mainBundle];
  }
  NSString *path = [[NSBundle mainBundle] pathForResource:lang ofType:@"lproj"];
  if (path == nil) {
    NSString *base = [[lang componentsSeparatedByString:@"-"] firstObject];
    path = [[NSBundle mainBundle] pathForResource:base ofType:@"lproj"];
  }
  NSBundle *bundle = (path != nil) ? [NSBundle bundleWithPath:path] : nil;
  return (bundle != nil) ? bundle : [NSBundle mainBundle];
}

/**
 * A notification string from `Localizable.strings`, in the app's own language.
 *
 * The extension has its OWN copy of this table and its own twin of this function: an app extension
 * is a separate bundle, so it cannot read the app's. See the `<lang>.lproj` folders of `canari_NSE`.
 *
 * COMPOSED ON THE DEVICE AND NOT BY THE SERVER, for a reason no amount of server-side translation
 * would fix: the server does not know the recipient's language, so every sentence it writes is
 * French for everyone. The device is the only layer that knows.
 */
static NSString *CanariLocalized(NSString *key) {
  return [CanariLocaleBundle() localizedStringForKey:key value:key table:nil];
}

static NSString *CanariBuildFallbackText(NSString *senderName) {
  if (senderName.length > 0) {
    return [NSString stringWithFormat:CanariLocalized(@"notif.message.from"), senderName];
  }
  return CanariLocalized(@"notif.message.encrypted");
}

/**
 * Writes a server-sent notification's sentence in the language chosen inside Canari.
 *
 * The services are the only layer that cannot know the reader's language - no header carries it and
 * no column stores it - so they send WHAT the notification is (`contentKey`) plus the two pieces
 * that are not translatable, and this writes it. Leaves `title` / `body` untouched when the key is
 * absent (a server predating the change) or unknown to this build, and says so in the log: once the
 * shim is gone, either means a payload that lost a field.
 *
 * The NSE has the same function in Swift; it runs when the app is not alive, this one when it is.
 */
static void CanariComposeServerNotification(NSDictionary *data, NSString **title, NSString **body) {
  NSString *key = [data[@"contentKey"] isKindOfClass:[NSString class]] ? data[@"contentKey"] : @"";
  if (key.length == 0) {
    NSLog(@"[CanariPush] server push with no contentKey - keeping its own wording");
    return;
  }
  NSString *actor = [data[@"actorName"] isKindOfClass:[NSString class]] ? data[@"actorName"] : @"";
  NSString *arg = [data[@"contentArg"] isKindOfClass:[NSString class]] ? data[@"contentArg"] : @"";

  NSDictionary<NSString *, NSString *> *actorTitled = @{
    @"social_mention" : @"mention",
    @"social_reply" : @"reply",
    @"social_comment" : @"comment",
    // The two publication notices: same shape, the actor naming the title and the post's own
    // opening as the body. `actorName` is the ASSOCIATION for the first, the author for the second.
    @"social_association_post" : @"association_post",
    @"social_followed_post" : @"followed_post",
    // Republication (D38): the republishing, then the proposing, association names the title.
    @"social_association_repost" : @"association_repost",
    @"social_repost_proposed" : @"repost_proposed",
    // D38b: an association asks the AUTHOR to republish their personal post.
    @"social_repost_personal_requested" : @"repost_personal_requested",
    // Co-organisation (D39): the organising association names the title, the event is the body.
    @"social_coorganise_proposed" : @"coorganise_proposed",
    // A live started (WP-L7): the broadcaster - a person or an association - names the title, and
    // the body is always the fixed sentence (the server sends no fragment).
    @"social_live_started" : @"live_started",
    // A follow request and its acceptance (WP-F2): the person names the title, fixed body.
    @"social_follow_request" : @"follow_request",
    @"social_follow_accepted" : @"follow_accepted",
    // The bookings' notices (WP-N): who acted names the title, the place (or the organiser's word)
    // is the body, a fixed sentence on a link-only space (Q-R5).
    @"social_booking_cancelled" : @"booking_cancelled",
    @"social_booking_withdrawn" : @"booking_withdrawn",
    @"social_booking_added" : @"booking_added",
  };
  NSString *stem = actorTitled[key];
  if (stem) {
    *title = [NSString
        stringWithFormat:CanariLocalized([NSString stringWithFormat:@"notif.social.%@.title", stem]),
                         actor];
    *body = arg.length > 0
                ? arg
                : CanariLocalized([NSString stringWithFormat:@"notif.social.%@.body", stem]);
    return;
  }
  // The strike ladder's three notices to a broadcaster (WP-L8b): fixed sentences, no actor and no
  // fragment.
  NSDictionary<NSString *, NSString *> *fixedSocial = @{
    @"social_live_cut" : @"live_cut",
    @"social_live_suspended" : @"live_suspended",
    @"social_live_withdrawn" : @"live_withdrawn",
  };
  NSString *fixedStem = fixedSocial[key];
  if (fixedStem) {
    *title = CanariLocalized([NSString stringWithFormat:@"notif.social.%@.title", fixedStem]);
    *body = CanariLocalized([NSString stringWithFormat:@"notif.social.%@.body", fixedStem]);
    return;
  }
  // The bookings' reminder (WP-N): nobody acted, a fixed title; the body is the place and the time.
  if ([key isEqualToString:@"social_booking_reminder"]) {
    *title = CanariLocalized(@"notif.social.booking_reminder.title");
    *body = arg.length > 0 ? arg : CanariLocalized(@"notif.social.booking_reminder.body");
    return;
  }
  if ([key isEqualToString:@"social_reaction"]) {
    *title = CanariLocalized(@"notif.social.reaction.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.social.reaction.body"), actor, arg];
    return;
  }
  if ([key isEqualToString:@"form_opening_soon"]) {
    *title = CanariLocalized(@"notif.form.opening_soon.title");
    *body = CanariLocalized(@"notif.form.opening_soon.body");
    return;
  }
  if ([key isEqualToString:@"form_open"]) {
    *title = CanariLocalized(@"notif.form.open.title");
    *body = CanariLocalized(@"notif.form.open.body");
    return;
  }
  // A payment landed on a full form, to the form's managers: `arg` is the form's title only.
  if ([key isEqualToString:@"form_paid_over_capacity"]) {
    *title = CanariLocalized(@"notif.form.paid_over_capacity.title");
    *body =
        [NSString stringWithFormat:CanariLocalized(@"notif.form.paid_over_capacity.body"), arg];
    return;
  }
  // An association's Lydia payments became active / were paused, to its payout managers: `arg` is
  // the association's name only.
  if ([key isEqualToString:@"lydia_payments_active"]) {
    *title = CanariLocalized(@"notif.lydia_payments_active.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.lydia_payments_active.body"), arg];
    return;
  }
  if ([key isEqualToString:@"lydia_payments_paused"]) {
    *title = CanariLocalized(@"notif.lydia_payments_paused.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.lydia_payments_paused.body"), arg];
    return;
  }
  // A payer refunded by an association: `arg` is the association's name only.
  if ([key isEqualToString:@"lydia_refund_issued"]) {
    *title = CanariLocalized(@"notif.lydia_refund_issued.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.lydia_refund_issued.body"), arg];
    return;
  }
  // The agenda's five. `arg` is the event's title; only `event_proposed` also names the actor.
  if ([key isEqualToString:@"event_proposed"]) {
    *title = CanariLocalized(@"notif.event.proposed.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.event.proposed.body"), actor, arg];
    return;
  }
  if ([key isEqualToString:@"event_validated"]) {
    *title = CanariLocalized(@"notif.event.validated.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.event.validated.body"), arg];
    return;
  }
  if ([key isEqualToString:@"event_rejected"]) {
    *title = CanariLocalized(@"notif.event.rejected.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.event.rejected.body"), arg];
    return;
  }
  if ([key isEqualToString:@"event_updated"]) {
    *title = CanariLocalized(@"notif.event.updated.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.event.updated.body"), arg];
    return;
  }
  if ([key isEqualToString:@"event_deleted"]) {
    *title = CanariLocalized(@"notif.event.deleted.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.event.deleted.body"), arg];
    return;
  }
  if ([key isEqualToString:@"event_pending"]) {
    *title = CanariLocalized(@"notif.event.pending.title");
    *body = [NSString stringWithFormat:CanariLocalized(@"notif.event.pending.body"), arg];
    return;
  }
  NSLog(@"[CanariPush] unknown contentKey=%@ - keeping the server's own wording", key);
}

/** The sentence shown for a reaction. See `CanariLocalized` for where the language comes from. */
static NSString *CanariReactionBody(NSString *emoji) {
  NSString *safeEmoji = (emoji.length > 0) ? emoji : @"";
  return [NSString stringWithFormat:CanariLocalized(@"notif.reaction.body"), safeEmoji];
}

static int CanariStableNotifId(NSString *groupId) {
  if (groupId.length == 0) {
    return 0;
  }
  NSUserDefaults *prefs = [[NSUserDefaults alloc] initWithSuiteName:@"canari_notif_ids"];
  NSNumber *existing = [prefs objectForKey:groupId];
  if (existing != nil) {
    return existing.intValue;
  }
  int next = (int)[prefs integerForKey:@"__counter__"];
  if (next < 1000) {
    next = 1000;
  }
  [prefs setObject:@(next) forKey:groupId];
  [prefs setInteger:next + 1 forKey:@"__counter__"];
  [prefs synchronize];
  return next;
}

static NSString *_Nullable CanariFetchProtoFromBackend(NSString *queuedMessageId, CanariPushContext *ctx) {
  NSString *secret = CanariRetrievePushSecret();
  if (secret == nil) {
    NSLog(@"[CanariPush] fetchProto: pushSecret absent");
    return nil;
  }
  for (int attempt = 0; attempt < 2; attempt++) {
    @try {
      NSString *encodedMsg =
          [queuedMessageId stringByAddingPercentEncodingWithAllowedCharacters:
                               [NSCharacterSet URLQueryAllowedCharacterSet]];
      NSString *encodedUser =
          [ctx.userId stringByAddingPercentEncodingWithAllowedCharacters:
                           [NSCharacterSet URLQueryAllowedCharacterSet]];
      NSString *encodedDev =
          [ctx.deviceId stringByAddingPercentEncodingWithAllowedCharacters:
                           [NSCharacterSet URLQueryAllowedCharacterSet]];
      NSString *urlStr = [NSString
          stringWithFormat:@"%@/api/mls/push/fetch-proto?messageId=%@&userId=%@&deviceId=%@",
                           ctx.baseUrl, encodedMsg, encodedUser, encodedDev];
      NSURL *url = [NSURL URLWithString:urlStr];
      NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
      req.HTTPMethod = @"GET";
      [req setValue:[NSString stringWithFormat:@"PushSecret %@", secret]
          forHTTPHeaderField:@"Authorization"];
      req.timeoutInterval = 5.0;

      dispatch_semaphore_t sem = dispatch_semaphore_create(0);
      __block NSString *protoResult = nil;
      [[[NSURLSession sharedSession] dataTaskWithRequest:req
                                       completionHandler:^(NSData *data, NSURLResponse *response,
                                                           NSError *error) {
                                         if (error == nil && data != nil) {
                                           NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
                                           if (http.statusCode == 200) {
                                             id json = [NSJSONSerialization JSONObjectWithData:data
                                                                                       options:0
                                                                                         error:nil];
                                             if ([json isKindOfClass:[NSDictionary class]]) {
                                               id proto = ((NSDictionary *)json)[@"proto"];
                                               if ([proto isKindOfClass:[NSString class]] &&
                                                   [(NSString *)proto length] > 0) {
                                                 protoResult = proto;
                                               }
                                             }
                                           }
                                         }
                                         dispatch_semaphore_signal(sem);
                                       }] resume];
      // Bridges NSURLSession's async completion into the synchronous return this FFI caller
      // needs. The 6 s ceiling is a safety margin ABOVE the request's own 5 s timeoutInterval,
      // which is what actually bounds a slow network - this only fires if the completion
      // handler itself never runs (a stuck data task), and that case is distinguished from an
      // ordinary "server answered with no proto" by the log line below
      // (docs/wiki/frontend/android-ios-parity.md#2.2: a swallowed branch must log).
      if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 6 * NSEC_PER_SEC)) != 0) {
        NSLog(@"[CanariPush] fetchProto: 6s safety timeout fired, dataTask completion handler never returned");
      }
      if (protoResult != nil) {
        return protoResult;
      }
    } @catch (NSException *ex) {
      NSLog(@"[CanariPush] fetchProto exception: %@", ex.reason);
    }
    if (attempt == 0) {
      usleep(1000000);
    }
  }
  return nil;
}

// Fetches the ordered replayable commits for `groupId` with baseEpoch >= `sinceEpoch` via the
// PushSecret endpoint, returned as a JSON array string of base64 commit protos (`["b64",...]`, the
// shape canari_native_decrypt_message_with_commits expects), or nil on failure.
static NSString *_Nullable CanariFetchCommitsFromBackend(NSString *groupId, long long sinceEpoch,
                                                         CanariPushContext *ctx) {
  NSString *secret = CanariRetrievePushSecret();
  if (secret == nil) {
    NSLog(@"[CanariPush] fetchCommits: pushSecret absent");
    return nil;
  }
  @try {
    NSURL *url =
        [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/commits", ctx.baseUrl]];
    if (url == nil) {
      return nil;
    }
    NSDictionary *payload = @{
      @"userId" : ctx.userId,
      @"deviceId" : ctx.deviceId,
      @"groupId" : groupId,
      @"sinceEpoch" : @(sinceEpoch),
    };
    NSData *reqBody = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    if (reqBody == nil) {
      return nil;
    }
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    req.HTTPMethod = @"POST";
    req.HTTPBody = reqBody;
    [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [req setValue:[NSString stringWithFormat:@"PushSecret %@", secret]
        forHTTPHeaderField:@"Authorization"];
    req.timeoutInterval = 5.0;

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSString *commitsJson = nil;
    [[[NSURLSession sharedSession]
        dataTaskWithRequest:req
          completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            if (error == nil && data != nil) {
              NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
              // NestJS @Post returns 201 by default; accept both.
              if (http.statusCode == 200 || http.statusCode == 201) {
                id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                if ([json isKindOfClass:[NSDictionary class]]) {
                  id commits = ((NSDictionary *)json)[@"commits"];
                  NSMutableArray<NSString *> *protos = [NSMutableArray array];
                  if ([commits isKindOfClass:[NSArray class]]) {
                    for (id entry in (NSArray *)commits) {
                      if ([entry isKindOfClass:[NSDictionary class]]) {
                        id proto = ((NSDictionary *)entry)[@"proto"];
                        if ([proto isKindOfClass:[NSString class]] && [(NSString *)proto length] > 0) {
                          [protos addObject:(NSString *)proto];
                        }
                      }
                    }
                  }
                  NSData *out = [NSJSONSerialization dataWithJSONObject:protos options:0 error:nil];
                  if (out != nil) {
                    commitsJson = [[NSString alloc] initWithData:out encoding:NSUTF8StringEncoding];
                  }
                }
              }
            }
            dispatch_semaphore_signal(sem);
          }] resume];
    // See CanariFetchProtoFromBackend above: 6s is a safety margin above the request's own 5s
    // timeoutInterval, and only fires if the completion handler itself never ran.
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 6 * NSEC_PER_SEC)) != 0) {
      NSLog(@"[CanariPush] fetchCommits: 6s safety timeout fired, dataTask completion handler never returned");
    }
    return commitsJson;
  } @catch (NSException *ex) {
    NSLog(@"[CanariPush] fetchCommits exception: %@", ex.reason);
    return nil;
  }
}

static CanariDecryptedMessage *_Nullable CanariDecryptProto(CanariPushContext *ctx, NSString *groupId,
                                                           NSString *senderId, NSString *protoB64,
                                                           NSData *stateBytes) {
  if (ctx.deviceKeyB64.length == 0) {
    return nil;
  }
  NSData *cipher =
      [[NSData alloc] initWithBase64EncodedString:protoB64
                                          options:NSDataBase64DecodingIgnoreUnknownCharacters];
  if (cipher == nil || cipher.length == 0) {
    return nil;
  }

  char *jsonPtr = canari_native_decrypt_message(
      (const unsigned char *)stateBytes.bytes, stateBytes.length, ctx.deviceKeyB64.UTF8String,
      ctx.userId.UTF8String, ctx.deviceId.UTF8String, groupId.UTF8String,
      senderId.UTF8String, (const unsigned char *)cipher.bytes, cipher.length,
      (ctx.locale ?: @"").UTF8String);
  if (jsonPtr == nil) {
    return nil;
  }
  NSString *jsonStr = [NSString stringWithUTF8String:jsonPtr];
  canari_free_string(jsonPtr);
  return CanariParseDecryptedJson(jsonStr);
}

static CanariDecryptedMessage *_Nullable CanariTryDecrypt(NSString *queuedMessageId, NSString *groupId,
                                                         NSString *senderId,
                                                         NSString *_Nullable inlineProto) {
  if (queuedMessageId.length == 0) {
    return nil;
  }
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
    NSLog(@"[CanariPush] tryDecrypt: push_context.json absent");
    return nil;
  }

  NSString *protoB64 = inlineProto;
  if (protoB64.length == 0) {
    protoB64 = CanariFetchProtoFromBackend(queuedMessageId, ctx);
  }
  if (protoB64.length == 0) {
    return nil;
  }

  if (![g_mlsStateLock tryLock]) {
    NSLog(@"[CanariPush] tryDecrypt: MlsStateLock busy");
    return nil;
  }
  CanariDecryptedMessage *result = nil;
  @try {
    NSData *stateBytes = CanariLoadMlsState();
    if (stateBytes == nil) {
      NSLog(@"[CanariPush] tryDecrypt: mls.bin absent");
    } else {
      result = CanariDecryptProto(ctx, groupId, senderId, protoB64, stateBytes);
    }
  } @finally {
    [g_mlsStateLock unlock];
  }
  return result;
}

// Parses the JSON from canari_native_decrypt_message_with_commits (mirror of CanariDecryptProto).
static CanariDecryptedMessage *_Nullable CanariDecryptProtoWithCommits(
    CanariPushContext *ctx, NSString *groupId, NSString *senderId, NSString *commitsJson,
    NSString *protoB64, NSData *stateBytes) {
  if (ctx.deviceKeyB64.length == 0) {
    return nil;
  }
  NSData *cipher =
      [[NSData alloc] initWithBase64EncodedString:protoB64
                                          options:NSDataBase64DecodingIgnoreUnknownCharacters];
  if (cipher == nil || cipher.length == 0) {
    return nil;
  }
  char *jsonPtr = canari_native_decrypt_message_with_commits(
      (const unsigned char *)stateBytes.bytes, stateBytes.length, ctx.deviceKeyB64.UTF8String,
      ctx.userId.UTF8String, ctx.deviceId.UTF8String, groupId.UTF8String, senderId.UTF8String,
      commitsJson.UTF8String,
      (const unsigned char *)cipher.bytes, cipher.length, (ctx.locale ?: @"").UTF8String);
  if (jsonPtr == nil) {
    return nil;
  }
  NSString *jsonStr = [NSString stringWithUTF8String:jsonPtr];
  canari_free_string(jsonPtr);
  return CanariParseDecryptedJson(jsonStr);
}

// Read-only in-memory commit catch-up for a push whose epoch is AHEAD of the persisted mls.bin (a
// device added to the group advanced the epoch that this never-opened device never applied). Reads
// the current epoch, fetches the missing ordered commits (PushSecret), and applies them in memory to
// decrypt this message - a real notification instead of a generic fallback. NEVER persists mls.bin.
static CanariDecryptedMessage *_Nullable CanariTryDecryptWithCommitCatchup(
    NSString *queuedMessageId, NSString *groupId, NSString *senderId,
    NSString *_Nullable inlineProto) {
  if (queuedMessageId.length == 0 || groupId.length == 0) {
    return nil;
  }
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
    return nil;
  }
  if (ctx.deviceKeyB64.length == 0) {
    return nil;
  }

  NSString *protoB64 = inlineProto;
  if (protoB64.length == 0) {
    protoB64 = CanariFetchProtoFromBackend(queuedMessageId, ctx);
  }
  if (protoB64.length == 0) {
    return nil;
  }

  // 1) Read the current epoch (brief lock: mls.bin + Argon2).
  long long epoch = -1;
  if (![g_mlsStateLock tryLock]) {
    NSLog(@"[CanariPush] catchup: MlsStateLock busy (epoch)");
    return nil;
  }
  @try {
    NSData *stateBytes = CanariLoadMlsState();
    if (stateBytes != nil) {
      epoch = canari_native_group_epoch((const unsigned char *)stateBytes.bytes, stateBytes.length,
                                        ctx.deviceKeyB64.UTF8String, ctx.userId.UTF8String,
                                        ctx.deviceId.UTF8String, groupId.UTF8String);
    }
  } @finally {
    [g_mlsStateLock unlock];
  }
  if (epoch < 0) {
    NSLog(@"[CanariPush] catchup: unknown epoch group=%@", groupId);
    return nil;
  }

  // 2) Fetch the ordered commits since our epoch (outside the lock: HTTP).
  NSString *commitsJson = CanariFetchCommitsFromBackend(groupId, epoch, ctx);
  if (commitsJson.length == 0 || [commitsJson isEqualToString:@"[]"]) {
    NSLog(@"[CanariPush] catchup: no commit to catch up on (epoch=%lld)", epoch);
    return nil;
  }

  // 3) Apply the commits in memory and decrypt (brief lock).
  if (![g_mlsStateLock tryLock]) {
    NSLog(@"[CanariPush] catchup: MlsStateLock busy (decrypt)");
    return nil;
  }
  CanariDecryptedMessage *result = nil;
  @try {
    NSData *stateBytes = CanariLoadMlsState();
    if (stateBytes != nil) {
      result = CanariDecryptProtoWithCommits(ctx, groupId, senderId, commitsJson, protoB64, stateBytes);
    }
  } @finally {
    [g_mlsStateLock unlock];
  }
  return result;
}

/**
 * Appends one entry to the app's `fcm_message_cache.ndjson`, bounded to kMaxFcmCacheEntries.
 * Two callers write it: a push decrypted while the app was dead, and a notification quick reply
 * this device SENT while the app was dead (CanariWriteSentMessageToCache).
 *
 * Each line is SEALED under the install's native cache key before it touches the disk. With no key
 * the entry is NOT written - never in the clear: the message is still on the server.
 */
static void CanariAppendFcmCacheEntry(NSDictionary *entry, NSString *messageId) {
  NSData *entryData = [NSJSONSerialization dataWithJSONObject:entry options:0 error:nil];
  if (entryData == nil) {
    NSLog(@"[CanariPush] writeFcmCache: JSON encoding failed");
    return;
  }
  NSString *plainLine =
      [[NSString alloc] initWithData:entryData encoding:NSUTF8StringEncoding];
  char *sealedPtr = canari_native_seal_cache_line(CanariRetrieveNativeCacheKey().UTF8String,
                                                  plainLine.UTF8String);
  if (sealedPtr == nil) {
    NSLog(@"[CanariPush] writeFcmCache: ERROR no cache key - entry NOT written messageId=%@",
          [messageId substringToIndex:MIN((NSUInteger)8, messageId.length)]);
    return;
  }
  NSString *entryLine = [NSString stringWithUTF8String:sealedPtr];
  canari_free_string(sealedPtr);
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return;
  }
  NSString *path = [dir stringByAppendingPathComponent:kFcmCacheFileName];

  [g_cacheLock lock];
  @try {
    NSString *existing = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    if (existing.length > 0) {
      for (NSString *line in [existing componentsSeparatedByString:@"\n"]) {
        if (line.length > 0) {
          [lines addObject:line];
        }
      }
    }
    while (lines.count >= kMaxFcmCacheEntries) {
      [lines removeObjectAtIndex:0];
    }
    [lines addObject:entryLine];
    NSString *body = [[lines componentsJoinedByString:@"\n"] stringByAppendingString:@"\n"];
    [body writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    CanariExcludeNativeCacheFilesFromBackup(dir);
    NSLog(@"[CanariPush] writeFcmCache messageId=%@", [messageId substringToIndex:MIN((NSUInteger)8, messageId.length)]);
  } @finally {
    [g_cacheLock unlock];
  }
}

static void CanariWriteFcmCache(NSString *groupId, NSString *senderId, NSString *senderName,
                                NSString *groupName, NSNumber *isGroup,
                                CanariDecryptedMessage *msg) {
  if (msg.messageId.length == 0) {
    return;
  }
  NSMutableDictionary *entry = [@{
    @"groupId" : groupId ?: @"",
    @"messageId" : msg.messageId,
    @"senderId" : senderId ?: @"",
    @"senderName" : senderName ?: @"",
    // THE CONVERSATION'S NAME AND ITS KIND, which the other two writers have carried since
    // 2026-09-15 and 2026-09-21 and this one did not carry at all: the web consumer builds a
    // placeholder row from this entry, and with neither it labelled the row after whoever messaged
    // first and typed it a DM. `groupName` is the LABEL; `isGroup` is the discriminator, omitted
    // below when the push did not say - an absent key means "no information", not `false`.
    @"groupName" : groupName ?: @"",
    @"content" : msg.text ?: @"",
    @"timestamp" : @(msg.sentAt),
    @"type" : msg.type ?: @"text",
  } mutableCopy];
  if (isGroup != nil) {
    entry[@"isGroup"] = isGroup;
  }
  if (msg.mediaKind.length > 0) {
    entry[@"mediaKind"] = msg.mediaKind;
  }
  CanariAppendFcmCacheEntry(entry, msg.messageId);
}

/**
 * Records a message this device SENT from a notification quick reply, so the app injects it into
 * the conversation at next open. The reply is built and delivered entirely natively: it never
 * becomes a TypeScript outbox entry, and `reconcileOutboxSent` only deletes entries - so without
 * this, a reply the peers received leaves no trace at all on the device that sent it. `senderId`
 * is OUR user id, which is what makes the injection path treat the row as our own message
 * (`mapStoredMessagesToChatMessages` derives isOwn from it) rather than a phantom unread.
 * Android twin: writeSentMessageToCache in CanariFirebaseMessagingService.kt.
 */
static void CanariWriteSentMessageToCache(NSString *groupId, NSString *selfUserId,
                                          NSString *messageId, NSString *text, long long sentAt) {
  if (messageId.length == 0 || selfUserId.length == 0) {
    NSLog(@"[CanariPush] writeSentMessageToCache: missing messageId/userId -> entry ignored");
    return;
  }
  CanariAppendFcmCacheEntry(@{
    @"groupId" : groupId ?: @"",
    @"messageId" : messageId,
    @"senderId" : selfUserId,
    @"senderName" : @"",
    @"content" : text ?: @"",
    @"timestamp" : @(sentAt),
    @"type" : @"text",
  }, messageId);
}

/**
 * Moves the entries the Notification Service Extension wrote into the App Group container over
 * to the app's own `fcm_message_cache.ndjson`, which is the only file `take_fcm_cache`
 * looks at. An app extension has its own data container, so this hop is what makes a push
 * decrypted while the app was killed visible to the app at all.
 */
void CanariDrainAppGroupFcmCache(void) {
  NSURL *container = [[NSFileManager defaultManager]
      containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
  NSString *dst = CanariTauriDataDir();
  if (container == nil || dst == nil) {
    return;
  }
  NSURL *srcUrl = [container URLByAppendingPathComponent:kFcmCacheFileName];
  NSString *incoming = [NSString stringWithContentsOfURL:srcUrl
                                                encoding:NSUTF8StringEncoding
                                                   error:nil];
  if (incoming.length == 0) {
    return;
  }
  // Delete first: an NSE invocation racing this drain would otherwise have its entry read and
  // then deleted anyway. Losing one costs latency only - the message is still in the pending
  // queue, since a push decrypt acknowledges nothing.
  [[NSFileManager defaultManager] removeItemAtURL:srcUrl error:nil];

  NSString *path = [dst stringByAppendingPathComponent:kFcmCacheFileName];
  [g_cacheLock lock];
  @try {
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    NSString *existing = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
    for (NSString *line in [existing componentsSeparatedByString:@"\n"]) {
      if (line.length > 0) {
        [lines addObject:line];
      }
    }
    for (NSString *line in [incoming componentsSeparatedByString:@"\n"]) {
      if (line.length > 0) {
        [lines addObject:line];
      }
    }
    while (lines.count > kMaxFcmCacheEntries) {
      [lines removeObjectAtIndex:0];
    }
    NSString *body = [[lines componentsJoinedByString:@"\n"] stringByAppendingString:@"\n"];
    [body writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    CanariExcludeNativeCacheFilesFromBackup(dst);
    NSLog(@"[CanariPush] drainAppGroupFcmCache: %lu entry/entries carried over", (unsigned long)lines.count);
  } @finally {
    [g_cacheLock unlock];
  }
}


/**
 * Number of distinct unread conversations among `delivered`, ignoring `excludedIds`.
 *
 * A conversation is keyed by its per-conversation thread when the NSE delivered it (killed app), or
 * by the stable request id when the in-app path delivered it (flat "canari_messages" thread) - both
 * are unique per conversation.
 *
 * `excludedIds` exists so a caller that has JUST asked for some notifications to be removed can
 * compute the badge from what will remain. `removeDeliveredNotificationsWithIdentifiers:` has no
 * completion handler, so re-reading the centre right after it is a race with no winner declared -
 * and the answer is already in the array the caller holds.
 */
static NSUInteger CanariCountUnreadConversations(NSArray<UNNotification *> *delivered,
                                                 NSSet<NSString *> *_Nullable excludedIds) {
  NSMutableSet<NSString *> *convKeys = [NSMutableSet set];
  for (UNNotification *n in delivered) {
    if (excludedIds != nil && [excludedIds containsObject:n.request.identifier]) {
      continue;
    }
    NSString *thread = n.request.content.threadIdentifier ?: @"";
    NSString *deepLink = n.request.content.userInfo[@"deepLink"] ?: @"";
    BOOL isChat = [thread isEqualToString:@"canari_messages"] ||
                  [deepLink hasPrefix:@"fr.emse.canari://chat"];
    if (!isChat) {
      continue;
    }
    [convKeys addObject:[thread isEqualToString:@"canari_messages"] ? n.request.identifier : thread];
  }
  return convKeys.count;
}

/** Writes the app-icon badge (WP-XP-2). Main thread, both OS spellings. */
static void CanariSetBadgeCount(NSUInteger count) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (@available(iOS 16.0, *)) {
      [[UNUserNotificationCenter currentNotificationCenter] setBadgeCount:count
                                                    withCompletionHandler:nil];
    } else {
      [UIApplication sharedApplication].applicationIconBadgeNumber = (NSInteger)count;
    }
    NSLog(@"[CanariPush] setBadgeCount: badge=%lu", (unsigned long)count);
  });
}

/**
 * Recomputes the app-icon badge (WP-XP-2) from the currently delivered chat notifications so it
 * always mirrors the number of distinct unread conversations. This is the app-process counterpart
 * of the NSE's `content.badge` write (NotificationService.swift): when the app is alive it owns the
 * badge; when killed the NSE does.
 */
static void CanariUpdateAppBadge(void) {
  [[UNUserNotificationCenter currentNotificationCenter]
      getDeliveredNotificationsWithCompletionHandler:^(
          NSArray<UNNotification *> *_Nonnull delivered) {
        CanariSetBadgeCount(CanariCountUnreadConversations(delivered, nil));
      }];
}

// The palette-A trills (docs/wiki/frontend/sounds.md), bundled in the app from the Android raw
// files the renderer writes. The same three names are spelled by `push-payload.ts` (the APNs
// `sound`) and the extension; `iosNotificationSounds.test.ts` holds the four together.
static NSString *const kCanariSoundMessage = @"canari_gazouillis_message.wav";
static NSString *const kCanariSoundMention = @"canari_gazouillis_mention.wav";
static NSString *const kCanariSoundReaction = @"canari_gazouillis_reaction.wav";

/// `sentAt` is the SENDER's instant for the message this notification is about, in ms, and it is
/// stamped into `userInfo` so the quick actions can acknowledge the conversation without looking
/// anything up - see `CanariSendReadWatermark`. 0 means unknown, which those actions read as "say
/// nothing" rather than substituting a clock.
///
/// `soundFile` names one of the bundled palette-A files; nil is the system default, which is what a
/// post, a form and the pending-sync notice keep (Android files those on silent-or-default channels).
static void CanariShowLocalNotification(NSString *title, NSString *body, NSString *deepLink,
                                      NSString *threadId, int notifId,
                                      NSString *_Nullable attachmentPath,
                                      NSString *_Nullable groupId, BOOL timeSensitive,
                                      NSString *_Nullable subtitle, long long sentAt,
                                      NSString *_Nullable soundFile) {
  // WP-XP-7: per-conversation notifications use the groupId as thread, not the flat
  // "canari_messages" thread. Suppress the foreground guard ONLY for the old flat thread;
  // per-conversation notifications should still post (they might be from a conversation
  // that isn't the one currently open - iOS handles stacking gracefully).
  if (canari_ios_is_in_foreground() && [threadId isEqualToString:@"canari_messages"]) {
    return;
  }

  UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
  content.title = title.length > 0 ? title : @"Canari";
  content.body = body ?: @"";
  content.sound = soundFile.length > 0 ? [UNNotificationSound soundNamed:soundFile]
                                       : [UNNotificationSound defaultSound];
  content.threadIdentifier = threadId;
  // Inside a group conversation, surface who spoke as a subtitle (WP-XP-7). NSE twin is
  // in NotificationService.swift applyMessageContent.
  if (subtitle.length > 0) {
    content.subtitle = subtitle;
  }
  // No group-summary text here: UNMutableNotificationContent.summaryArgument was deprecated in
  // iOS 15.0 and is ignored by the system, and the deployment target is 16.0 - so there is no
  // reachable version where setting it would do anything. iOS stacks by threadIdentifier and
  // writes the summary line itself. The Android twin (GROUP_KEY_MESSAGES, refreshBadgeSummary)
  // has no iOS counterpart; giving iOS a real summary line is a separate, unbuilt feature.
  // @-mention of me (WP-XP-5): break through Focus. Requires the app's Time Sensitive
  // Notifications entitlement; silently downgraded to .active without it.
  if (timeSensitive) {
    if (@available(iOS 15.0, *)) {
      content.interruptionLevel = UNNotificationInterruptionLevelTimeSensitive;
    }
  }

  NSMutableDictionary *userInfo = [NSMutableDictionary dictionary];
  if (deepLink.length > 0) {
    userInfo[@"deepLink"] = deepLink;
  }
  // Quick actions (WP-XP-1): MLS-only (DM/group), never on a channel_ conversation - channels are
  // server-authoritative and do not go through the MLS outbox (see outbox.ts isChannelConversationId).
  if (groupId.length > 0 && ![groupId hasPrefix:@"channel_"]) {
    userInfo[@"groupId"] = groupId;
    if (sentAt > 0) {
      userInfo[@"sentAt"] = @(sentAt);
    }
    content.categoryIdentifier = kCanariMessageCategoryId;
  }
  if (userInfo.count > 0) {
    content.userInfo = userInfo;
  }

  if (attachmentPath.length > 0 &&
      [[NSFileManager defaultManager] fileExistsAtPath:attachmentPath]) {
    NSError *attachErr = nil;
    UNNotificationAttachment *attachment =
        [UNNotificationAttachment attachmentWithIdentifier:@"avatar"
                                                       URL:[NSURL fileURLWithPath:attachmentPath]
                                                   options:nil
                                                     error:&attachErr];
    if (attachment != nil) {
      content.attachments = @[ attachment ];
    } else if (attachErr != nil) {
      NSLog(@"[CanariPush] attachment error: %@", CanariErrorReason(attachErr));
    }
  }

  NSString *requestId =
      notifId > 0 ? [NSString stringWithFormat:@"canari-%d", notifId] : [[NSUUID UUID] UUIDString];
  UNNotificationRequest *request =
      [UNNotificationRequest requestWithIdentifier:requestId content:content trigger:nil];
  [[UNUserNotificationCenter currentNotificationCenter]
      addNotificationRequest:request
       withCompletionHandler:^(NSError *_Nullable error) {
         if (error != nil) {
           NSLog(@"[CanariPush] showNotification error: %@", CanariErrorReason(error));
         } else {
#if CANARI_BENCH
           // HOW IT WAS FILED, for the cross-client rig on a BENCH build only (O13): the in-app
           // twin of the extension's `logFiling`, so a row reads both transports the same way.
           NSString *level = @"unavailable";
           if (@available(iOS 15.0, *)) {
             switch (content.interruptionLevel) {
               case UNNotificationInterruptionLevelPassive: level = @"passive"; break;
               case UNNotificationInterruptionLevelActive: level = @"active"; break;
               case UNNotificationInterruptionLevelTimeSensitive: level = @"timeSensitive"; break;
               case UNNotificationInterruptionLevelCritical: level = @"critical"; break;
               default:
                 level = [NSString stringWithFormat:@"unknown(%lu)", (unsigned long)content.interruptionLevel];
             }
           }
           NSLog(@"[CanariPush] filed interruptionLevel=%@ thread=%@ via=app", level,
                 [threadId substringToIndex:MIN((NSUInteger)8, threadId.length)]);
#endif
           // Refresh the launcher badge (WP-XP-2) after ANY chat notification is posted.
           // The badge counts distinct delivered conversations, not just the old flat thread.
           CanariUpdateAppBadge();
         }
       }];
}

/**
 * The locale the quick-action titles were last registered with, so a refresh that would change
 * nothing does nothing. Empty string = registered against the default (nothing mirrored yet);
 * nil = never registered. Only ever read and written on the main queue (`CanariPushSetup` and the
 * `UIApplicationWillResignActive` observer both run there).
 */
static NSString *g_registeredCategoryLocale = nil;

/**
 * Registers the `UNNotificationCategory` backing the message notification quick actions
 * (WP-XP-1): inline reply (text input) and mark as read. Only notifications built with
 * `groupId` set (see `CanariShowLocalNotification`) opt into this category - never a `channel_`
 * conversation (channels are server-authoritative, no MLS outbox to route a reply/receipt through).
 *
 * THE TITLES FOLLOW A LANGUAGE CHANGE, and this is the one place on iOS where that is possible:
 * `setNotificationCategories` REPLACES the whole set, where an Android channel name is written once
 * at creation and never again. What makes the refresh a proof rather than a poll: a quick-action
 * title is only ever READ on a notification the user can see, and seeing one requires the app not
 * to be frontmost - so `UIApplicationWillResignActive`, which calls this, cannot be skipped between
 * the settings toggle that changes the language and the first banner that shows the titles. The
 * locale guard makes every other call free.
 */
void CanariRefreshNotificationCategories(void) {
  CanariPushContext *ctx = CanariLoadPushContext();
  NSString *locale = (ctx.locale.length > 0) ? ctx.locale : @"";
  if (g_registeredCategoryLocale != nil && [g_registeredCategoryLocale isEqualToString:locale]) {
    return;
  }
  UNTextInputNotificationAction *replyAction = [UNTextInputNotificationAction
      actionWithIdentifier:kCanariReplyActionId
                     title:CanariLocalized(@"notif.action.reply")
                   options:UNNotificationActionOptionNone
      textInputButtonTitle:CanariLocalized(@"notif.action.send")
      textInputPlaceholder:@""];
  UNNotificationAction *markReadAction =
      [UNNotificationAction actionWithIdentifier:kCanariMarkReadActionId
                                            title:CanariLocalized(@"notif.action.mark_read")
                                          options:UNNotificationActionOptionNone];
  UNNotificationCategory *category =
      [UNNotificationCategory categoryWithIdentifier:kCanariMessageCategoryId
                                              actions:@[ replyAction, markReadAction ]
                                    intentIdentifiers:@[]
                                              options:UNNotificationCategoryOptionNone];
  [[UNUserNotificationCenter currentNotificationCenter]
      setNotificationCategories:[NSSet setWithObject:category]];
  g_registeredCategoryLocale = locale;
  NSLog(@"[CanariPush] notification categories registered locale=%@",
        locale.length > 0 ? locale : @"(default)");
}

/**
 * Removes this device's notification for one conversation - the visible half of the cross-device
 * read-state sync (a `channel_read` frame, an MLS silent read receipt, or the "mark as read" quick
 * action). Also used for a conversation opened locally.
 *
 * IT CANCELS BY THREAD, NOT BY IDENTIFIER, because the two paths that post a conversation's
 * notification do not agree on an identifier and only one of them is ours. A notification posted
 * in-app (`CanariShowLocalNotification`) carries `canari-<stableId>`; one posted by APNs and
 * rewritten by the Notification Service Extension - THE ONLY PATH THAT RUNS WHEN THE APP IS KILLED,
 * i.e. exactly the case a read on another device has to clean up - carries an identifier the system
 * assigned, which `canari-<stableId>` never matches. So this used to remove nothing at all on a
 * killed iPhone: the salon banner stayed up for a message already read on the laptop, and the badge
 * was recomputed from a set that still contained it.
 *
 * The `threadIdentifier` IS the conversation on both paths (`groupId`, or `channel_<id>` for a
 * community channel), so it is what the removal is keyed on. The stable id is still dropped from
 * the PENDING queue, where it is the only thing that can be scheduled under it.
 *
 * `done` runs once the removal has been issued (or at once for an empty id). A caller that holds a
 * background wake - the silent-frame hook - must not hand its completion back before then, or iOS
 * may suspend the process with the removal still queued.
 */
static void CanariCancelConversationNotification(NSString *groupId, void (^_Nullable done)(void)) {
  if (groupId.length == 0) {
    if (done != nil) {
      done();
    }
    return;
  }
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  NSString *requestId = [NSString stringWithFormat:@"canari-%d", CanariStableNotifId(groupId)];
  [center removePendingNotificationRequestsWithIdentifiers:@[ requestId ]];
  [center getDeliveredNotificationsWithCompletionHandler:^(
              NSArray<UNNotification *> *_Nonnull notifications) {
    NSMutableArray<NSString *> *ids = [NSMutableArray array];
    for (UNNotification *n in notifications) {
      if ([n.request.content.threadIdentifier isEqualToString:groupId] ||
          [n.request.identifier isEqualToString:requestId]) {
        [ids addObject:n.request.identifier];
      }
    }
    if (ids.count > 0) {
      [center removeDeliveredNotificationsWithIdentifiers:ids];
    }
    NSLog(@"[CanariPush] cancelConversationNotification group=%@ removed=%lu", groupId,
          (unsigned long)ids.count);
    // The badge counts what REMAINS, computed from the array in hand rather than by re-reading a
    // centre whose removal has no completion handler to wait on.
    CanariSetBadgeCount(CanariCountUnreadConversations(notifications, [NSSet setWithArray:ids]));
    if (done != nil) {
      done();
    }
  }];
}

static NSData *_Nullable CanariHttpRequest(NSString *method, NSURL *url, NSString *_Nullable secret,
                                           NSData *_Nullable body, int *outStatus) {
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
  req.HTTPMethod = method;
  req.timeoutInterval = 10.0;
  if (secret.length > 0) {
    [req setValue:[NSString stringWithFormat:@"PushSecret %@", secret]
        forHTTPHeaderField:@"Authorization"];
  }
  if (body != nil) {
    req.HTTPBody = body;
    [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSData *responseData = nil;
  __block NSInteger statusCode = 0;
  [[[NSURLSession sharedSession] dataTaskWithRequest:req
                                   completionHandler:^(NSData *data, NSURLResponse *response,
                                                       NSError *error) {
                                     if (error == nil) {
                                       responseData = data;
                                       statusCode = ((NSHTTPURLResponse *)response).statusCode;
                                     }
                                     dispatch_semaphore_signal(sem);
                                   }] resume];
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC));
  if (outStatus != nil) {
    *outStatus = (int)statusCode;
  }
  return responseData;
}

static void CanariMarkMembershipActive(CanariPushContext *ctx, NSString *secret, NSString *groupId) {
  NSURL *url =
      [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/membership-active", ctx.baseUrl]];
  NSDictionary *payload =
      @{@"userId" : ctx.userId, @"deviceId" : ctx.deviceId, @"groupId" : groupId};
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  int status = 0;
  CanariHttpRequest(@"POST", url, secret, body, &status);
  NSLog(@"[CanariPush] markMembershipActive: HTTP %d group=%@", status, groupId);
}

static void CanariFetchWelcomeBundle(NSString *queuedMessageId, CanariPushContext *ctx,
                                     NSString *secret, NSString **_Nullable outWelcome,
                                     NSString **_Nullable outRatchetTree) {
  *outWelcome = nil;
  *outRatchetTree = @"";
  NSString *encodedMsg =
      [queuedMessageId stringByAddingPercentEncodingWithAllowedCharacters:
                           [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *encodedUser =
      [ctx.userId stringByAddingPercentEncodingWithAllowedCharacters:
                       [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *encodedDev =
      [ctx.deviceId stringByAddingPercentEncodingWithAllowedCharacters:
                        [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *urlStr = [NSString
      stringWithFormat:@"%@/api/mls/push/fetch-proto?messageId=%@&userId=%@&deviceId=%@",
                       ctx.baseUrl, encodedMsg, encodedUser, encodedDev];
  int status = 0;
  NSData *resp = CanariHttpRequest(@"GET", [NSURL URLWithString:urlStr], secret, nil, &status);
  if (status != 200 || resp == nil) {
    NSLog(@"[CanariPush] fetchWelcomeBundle: HTTP %d", status);
    return;
  }
  id json = [NSJSONSerialization JSONObjectWithData:resp options:0 error:nil];
  if (![json isKindOfClass:[NSDictionary class]]) {
    return;
  }
  NSDictionary *dict = (NSDictionary *)json;
  if ([dict[@"proto"] isKindOfClass:[NSString class]]) {
    *outWelcome = dict[@"proto"];
  }
  if ([dict[@"ratchetTree"] isKindOfClass:[NSString class]]) {
    *outRatchetTree = dict[@"ratchetTree"];
  }
}

static void CanariRunBackgroundCleanup(void) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return;
  }
  int ok = canari_native_cleanup_pending_db(dir.UTF8String);
  NSLog(@"[CanariPush] background cleanup pending db: %d", ok);
}

#if __has_include(<BackgroundTasks/BackgroundTasks.h>)

/// Submits the next background-processing request. iOS coalesces and defers these on its own
/// schedule (no guaranteed cadence), and never wakes a force-quit app. Re-submitted on every
/// background entry and after each task run so a window always stays queued.
API_AVAILABLE(ios(13.0))
static void CanariSubmitBackgroundCleanupRequest(void) {
  BGProcessingTaskRequest *request =
      [[BGProcessingTaskRequest alloc] initWithIdentifier:kCanariBgCleanupTaskId];
  request.requiresNetworkConnectivity = NO;
  request.requiresExternalPower = NO;
  NSError *error = nil;
  if (![[BGTaskScheduler sharedScheduler] submitTaskRequest:request error:&error]) {
    NSLog(@"[CanariPush] BGTask submit failed: %@", CanariErrorReason(error));
  } else {
    NSLog(@"[CanariPush] BGTask cleanup scheduled");
  }
}

/// Registers the BGProcessingTask launch handler. MUST run before the app finishes launching -
/// it is called from canari_ios_bootstrap (i.e. before ffi::start_app()/UIApplicationMain), so
/// it is well within the deadline; the UIApplicationDidFinishLaunchingNotification observer, by
/// contrast, fires AFTER didFinishLaunching returns and would be too late (BGTaskScheduler throws).
API_AVAILABLE(ios(13.0))
static void CanariRegisterBackgroundCleanupHandler(void) {
  [[BGTaskScheduler sharedScheduler]
      registerForTaskWithIdentifier:kCanariBgCleanupTaskId
                         usingQueue:nil
                      launchHandler:^(__kindof BGTask *task) {
                        // The OS only keeps one pending request per identifier - queue the next
                        // window immediately so cleanup keeps recurring.
                        CanariSubmitBackgroundCleanupRequest();
                        task.expirationHandler = ^{
                          NSLog(@"[CanariPush] BGTask expired before the cleanup finished");
                        };
                        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                          CanariRunBackgroundCleanup();
                          [task setTaskCompletedWithSuccess:YES];
                        });
                      }];
  NSLog(@"[CanariPush] BGTask handler registered (%@)", kCanariBgCleanupTaskId);
}

// Forward declarations for functions used in the outbox-retry handler but defined later.
static int CanariDrainOutboxBackground(CanariPushContext *ctx);
static void CanariMaybeNotifyPendingSync(int remaining);

/// WP-XP-8: submits a BGProcessingTaskRequest for outbox retry. Unlike the cleanup task,
/// this one needs network connectivity (the outbox drain POSTs ciphertexts to the backend).
/// iOS coalesces and defers requests on its own schedule; resubmitted on every failure so a
/// window always stays queued until the drain succeeds.
API_AVAILABLE(ios(13.0))
static void CanariSubmitOutboxRetryRequest(void) {
  BGProcessingTaskRequest *request =
      [[BGProcessingTaskRequest alloc] initWithIdentifier:kCanariBgOutboxRetryTaskId];
  request.requiresNetworkConnectivity = YES;
  request.requiresExternalPower = NO;
  NSError *error = nil;
  if (![[BGTaskScheduler sharedScheduler] submitTaskRequest:request error:&error]) {
    NSLog(@"[CanariPush] BGTask outboxRetry submit failed: %@", CanariErrorReason(error));
  } else {
    NSLog(@"[CanariPush] BGTask outboxRetry scheduled");
  }
}

/// WP-XP-8: BGProcessingTask launch handler for the outbox retry. Drains the outbox mirror
/// in the background; if messages remain the next retry window is queued immediately.
API_AVAILABLE(ios(13.0))
static void CanariRegisterOutboxRetryHandler(void) {
  [[BGTaskScheduler sharedScheduler]
      registerForTaskWithIdentifier:kCanariBgOutboxRetryTaskId
                         usingQueue:nil
                      launchHandler:^(__kindof BGTask *task) {
                        CanariSubmitOutboxRetryRequest();
                        task.expirationHandler = ^{
                          NSLog(@"[CanariPush] BGTask outboxRetry expired before the drain finished");
                        };
                        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                          CanariPushContext *ctx = CanariLoadPushContext();
                          if (ctx != nil) {
                            int remaining = CanariDrainOutboxBackground(ctx);
                            if (remaining > 0) {
                              CanariMaybeNotifyPendingSync(remaining);
                            }
                            NSLog(@"[CanariPush] BGTask outboxRetry: %d remaining", remaining);
                          }
                          [task setTaskCompletedWithSuccess:YES];
                        });
                      }];
  NSLog(@"[CanariPush] BGTask outboxRetry handler registered (%@)", kCanariBgOutboxRetryTaskId);
}

#endif

void CanariRegisterBackgroundTasks(void) {
#if __has_include(<BackgroundTasks/BackgroundTasks.h>)
  if (@available(iOS 13.0, *)) {
    CanariRegisterBackgroundCleanupHandler();
    CanariRegisterOutboxRetryHandler();
  }
#endif
}

void CanariScheduleBackgroundCleanupTask(void) {
#if __has_include(<BackgroundTasks/BackgroundTasks.h>)
  if (@available(iOS 13.0, *)) {
    CanariSubmitBackgroundCleanupRequest();
  }
#endif
}

/// WP-XP-8: schedules the outbox retry BGProcessingTask. Called from
/// [CanariMaybeNotifyPendingSync] when the opportunistic drain leaves messages unsent.
void CanariScheduleOutboxRetryTask(void) {
#if __has_include(<BackgroundTasks/BackgroundTasks.h>)
  if (@available(iOS 13.0, *)) {
    CanariSubmitOutboxRetryRequest();
  }
#endif
}

static NSArray<CanariOutboxEntry *> *CanariReadOutboxMirror(void) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return @[];
  }
  NSString *path = [dir stringByAppendingPathComponent:kOutboxPendingFileName];
  NSString *content = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
  if (content.length == 0) {
    return @[];
  }
  NSMutableArray<CanariOutboxEntry *> *entries = [NSMutableArray array];
  for (NSString *line in [content componentsSeparatedByString:@"\n"]) {
    if (line.length == 0) {
      continue;
    }
    id json = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
                                              options:0
                                                error:nil];
    if (![json isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSDictionary *o = (NSDictionary *)json;
    NSString *entryId = [o[@"id"] isKindOfClass:[NSString class]] ? o[@"id"] : @"";
    NSString *groupId = [o[@"groupId"] isKindOfClass:[NSString class]] ? o[@"groupId"] : @"";
    NSString *proto = [o[@"proto"] isKindOfClass:[NSString class]] ? o[@"proto"] : @"";
    if (entryId.length == 0 || groupId.length == 0 || proto.length == 0) {
      continue;
    }
    CanariOutboxEntry *entry = [[CanariOutboxEntry alloc] init];
    entry.entryId = entryId;
    entry.groupId = groupId;
    entry.proto = proto;
    entry.sentAt = [o[@"sentAt"] respondsToSelector:@selector(longLongValue)]
                       ? [o[@"sentAt"] longLongValue]
                       : 0;
    entry.silent = [o[@"silent"] boolValue];
    // Defaults to YES: every entry the outbox mirrors carries conversation state, so a mirror file
    // written before this field existed must not be read as frames nobody may ever recover.
    entry.durable = o[@"durable"] == nil ? YES : [o[@"durable"] boolValue];
    [entries addObject:entry];
  }
  return entries;
}

static void CanariRewriteOutboxMirror(NSArray<CanariOutboxEntry *> *remaining) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return;
  }
  NSString *path = [dir stringByAppendingPathComponent:kOutboxPendingFileName];
  if (remaining.count == 0) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    return;
  }
  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  for (CanariOutboxEntry *e in remaining) {
    NSDictionary *obj = @{
      @"id" : e.entryId,
      @"groupId" : e.groupId,
      @"proto" : e.proto,
      @"sentAt" : @(e.sentAt),
      @"silent" : @(e.silent),
      @"durable" : @(e.durable),
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    if (data != nil) {
      [lines addObject:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]];
    }
  }
  NSString *body = [[lines componentsJoinedByString:@"\n"] stringByAppendingString:@"\n"];
  [body writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

static void CanariAppendOutboxSent(NSArray<NSString *> *ids) {
  if (ids.count == 0) {
    return;
  }
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return;
  }
  NSString *path = [dir stringByAppendingPathComponent:kOutboxSentFileName];
  NSString *existing = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
  if (existing == nil) {
    existing = @"";
  }
  NSString *append = [[ids componentsJoinedByString:@"\n"] stringByAppendingString:@"\n"];
  NSString *combined = [existing stringByAppendingString:append];
  [combined writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

/**
 * Encrypts every pending message in ONE FFI call under g_mlsStateLock (the Rust side loads mls.bin
 * once, advances the ratchet per entry, and rewrites mls.bin once - before returning any ciphertext,
 * so a frame is never handed out while its ratchet advance is not durable).
 *
 * Returns entry id -> ciphertext (base64) for the entries that encrypted; an entry missing from the
 * dictionary failed on its own (typically the group is not joined on this device yet) and stays
 * queued. Returns nil if the whole batch failed: state absent, lock unavailable, or the save failed
 * - in which case NOTHING may be posted.
 *
 * Per-message it was one full CBOR decode and one full re-serialise of the entire MLS keystore
 * EACH, i.e. O(N x |mls.bin|) inside the OS background deadline (WP-ANR-1). Android twin:
 * encryptQueuedMessages in CanariFirebaseMessagingService.kt.
 */
static NSDictionary<NSString *, NSString *> *_Nullable CanariEncryptQueuedMessages(
    CanariPushContext *ctx, NSArray<CanariOutboxEntry *> *entries) {
  if (ctx.deviceKeyB64.length == 0 || entries.count == 0) {
    return nil;
  }
  if (![g_mlsStateLock tryLock]) {
    NSLog(@"[CanariPush] encryptQueuedMessages: MlsStateLock busy");
    return nil;
  }
  NSMutableDictionary<NSString *, NSString *> *out = nil;
  @try {
    NSString *dir = CanariTauriDataDir();
    NSData *stateBytes = CanariLoadMlsState();
    if (dir == nil || stateBytes == nil) {
      NSLog(@"[CanariPush] encryptQueuedMessages: MLS state absent");
      return nil;
    }
    NSMutableArray *payload = [NSMutableArray arrayWithCapacity:entries.count];
    for (CanariOutboxEntry *entry in entries) {
      [payload addObject:@{
        @"id" : entry.entryId ?: @"",
        @"groupId" : entry.groupId ?: @"",
        @"proto" : entry.proto ?: @"",
      }];
    }
    NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    NSString *payloadStr = [[NSString alloc] initWithData:payloadData encoding:NSUTF8StringEncoding];
    char *jsonPtr = canari_native_send_messages_background(
        dir.UTF8String, (const unsigned char *)stateBytes.bytes, stateBytes.length,
        ctx.deviceKeyB64.UTF8String, ctx.userId.UTF8String, ctx.deviceId.UTF8String,
        payloadStr.UTF8String, kCanariDrainMaxBatch);
    if (jsonPtr == nil) {
      return nil;
    }
    NSString *jsonStr = [NSString stringWithUTF8String:jsonPtr];
    canari_free_string(jsonPtr);
    NSData *jsonData = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
    id json = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
    if (![json isKindOfClass:[NSDictionary class]] || ![json[@"ok"] boolValue]) {
      // The reason, not only the verdict: a refused write (the foreground guard, a moved
      // mls.bin) and an unreadable state end here alike, and only the Rust error tells them apart.
      id reason = [json isKindOfClass:[NSDictionary class]] ? json[@"error"] : nil;
      NSLog(@"[CanariPush] encryptQueuedMessages: ok=false (%@)",
            [reason isKindOfClass:[NSString class]] ? reason : @"no reason given");
      return nil;
    }
    id results = json[@"results"];
    if (![results isKindOfClass:[NSArray class]]) {
      return nil;
    }
    out = [NSMutableDictionary dictionaryWithCapacity:((NSArray *)results).count];
    for (id item in (NSArray *)results) {
      if (![item isKindOfClass:[NSDictionary class]]) {
        continue;
      }
      NSDictionary *r = item;
      NSString *entryId = [r[@"id"] isKindOfClass:[NSString class]] ? r[@"id"] : @"";
      if (entryId.length == 0) {
        continue;
      }
      if (![r[@"ok"] boolValue]) {
        NSLog(@"[CanariPush] encryptQueuedMessages: kept queued id=%@ (%@)", entryId, r[@"error"]);
        continue;
      }
      NSString *ct = [r[@"ciphertext"] isKindOfClass:[NSString class]] ? r[@"ciphertext"] : @"";
      if (ct.length > 0) {
        out[entryId] = ct;
      }
    }
  } @finally {
    [g_mlsStateLock unlock];
  }
  return out;
}

static BOOL CanariSendQueuedMessagePush(CanariPushContext *ctx, NSString *secret, NSString *groupId,
                                        NSString *ciphertextB64, NSString *messageId, BOOL silent,
                                        BOOL durable) {
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/send", ctx.baseUrl]];
  NSDictionary *payload = @{
    @"userId" : ctx.userId,
    @"deviceId" : ctx.deviceId,
    @"groupId" : groupId,
    @"proto" : ciphertextB64,
    @"messageId" : messageId,
    @"silent" : @(silent),
    @"durable" : @(durable),
  };
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  int status = 0;
  CanariHttpRequest(@"POST", url, secret, body, &status);
  NSLog(@"[CanariPush] sendQueuedMessagePush: HTTP %d group=%@ msg=%@", status, groupId, messageId);
  return status == 200 || status == 201;
}

static int CanariDrainOutboxBackground(CanariPushContext *ctx) {
  NSArray<CanariOutboxEntry *> *entries = CanariReadOutboxMirror();
  if (entries.count == 0) {
    return 0;
  }
  NSString *secret = CanariRetrievePushSecret();
  if (secret == nil) {
    NSLog(@"[CanariPush] drainOutboxBackground: pushSecret absent (%lu remaining)",
          (unsigned long)entries.count);
    return (int)entries.count;
  }
  // The native side attempts at most kCanariDrainMaxBatch entries, and only those can burn a
  // generation. It sees the whole queue so that a held group takes none of those slots.
  NSLog(@"[CanariPush] drainOutboxBackground: %lu message(s) queued, at most %lu attempted",
        (unsigned long)entries.count, (unsigned long)kCanariDrainMaxBatch);
  NSDictionary<NSString *, NSString *> *ciphertexts = CanariEncryptQueuedMessages(ctx, entries);
  if (ciphertexts == nil) {
    NSLog(@"[CanariPush] drainOutboxBackground: batch encrypt failed (%lu remaining)",
          (unsigned long)entries.count);
    return (int)entries.count;
  }
  NSTimeInterval deadline =
      [NSDate timeIntervalSinceReferenceDate] + (kCanariDrainPostBudgetMs / 1000.0);
  NSMutableArray<NSString *> *sentIds = [NSMutableArray array];
  NSMutableArray<CanariOutboxEntry *> *remaining = [NSMutableArray array];
  NSUInteger checkpointed = 0;
  NSUInteger index = 0;
  for (CanariOutboxEntry *entry in entries) {
    index++;
    if ([NSDate timeIntervalSinceReferenceDate] >= deadline) {
      // Out of budget: everything not yet attempted goes back untouched. The next drain continues
      // from here - partial progress is kept, never discarded.
      [remaining addObject:entry];
      continue;
    }
    NSString *ciphertext = ciphertexts[entry.entryId];
    if (ciphertext == nil) {
      [remaining addObject:entry];
      continue;
    }
    if (CanariSendQueuedMessagePush(ctx, secret, entry.groupId, ciphertext, entry.entryId,
                                    entry.silent, entry.durable)) {
      [sentIds addObject:entry.entryId];
    } else {
      [remaining addObject:entry];
    }
    // Checkpoint: a hard kill (the OS reclaiming the background task) would otherwise leave every
    // delivered message still in the mirror, and the next drain would send them all again. This
    // bounds that duplicate window to kCanariDrainCheckpointEvery.
    if (sentIds.count - checkpointed >= kCanariDrainCheckpointEvery) {
      CanariAppendOutboxSent(
          [sentIds subarrayWithRange:NSMakeRange(checkpointed, sentIds.count - checkpointed)]);
      checkpointed = sentIds.count;
      NSMutableArray<CanariOutboxEntry *> *notYetAttempted = [remaining mutableCopy];
      [notYetAttempted
          addObjectsFromArray:[entries subarrayWithRange:NSMakeRange(index, entries.count - index)]];
      CanariRewriteOutboxMirror(notYetAttempted);
    }
  }
  if (sentIds.count > checkpointed) {
    CanariAppendOutboxSent(
        [sentIds subarrayWithRange:NSMakeRange(checkpointed, sentIds.count - checkpointed)]);
  }
  NSMutableArray<CanariOutboxEntry *> *stillQueued = [remaining mutableCopy];
  CanariRewriteOutboxMirror(stillQueued);
  NSLog(@"[CanariPush] drainOutboxBackground: %lu sent, %lu remaining",
        (unsigned long)sentIds.count, (unsigned long)stillQueued.count);
  return (int)stillQueued.count;
}

/**
 * Records "this conversation is read up to `at`" in `read_watermarks.ndjson`, the cross-process
 * file the app merges at boot (`consumeNativeReadWatermarks`). Android twin: appendReadWatermark in
 * CanariFirebaseMessagingService.kt.
 *
 * THE FRAME IS NOT ENOUGH. The `read_watermark` control event queued alongside this reaches PEERS
 * and our own other devices; nothing carries it to THIS device's database, whose conversation row
 * draws the badge. Without it the user acknowledged a conversation from the shade, opened the app
 * and found it unread - which looks exactly like the action having done nothing.
 *
 * ONE LINE PER CONVERSATION, keeping the larger `at`: the merge on the far side is `max` anyway, so
 * collapsing here bounds the file by the number of conversations rather than by a cap that could
 * drop the very entry it was written for.
 */
static void CanariAppendReadWatermark(NSString *groupId, long long at) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil || groupId.length == 0 || at <= 0) {
    NSLog(@"[CanariPush] appendReadWatermark: group=%@ at=%lld -> nothing to record", groupId, at);
    return;
  }
  NSString *path = [dir stringByAppendingPathComponent:kReadWatermarkFileName];
  [g_cacheLock lock];
  @try {
    NSMutableDictionary<NSString *, NSNumber *> *byGroup = [NSMutableDictionary dictionary];
    NSString *content = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
    for (NSString *line in [content componentsSeparatedByString:@"\n"]) {
      if (line.length == 0) {
        continue;
      }
      id json = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
                                                options:0
                                                  error:nil];
      if (![json isKindOfClass:[NSDictionary class]]) {
        continue;
      }
      NSDictionary *o = (NSDictionary *)json;
      NSString *g = [o[@"groupId"] isKindOfClass:[NSString class]] ? o[@"groupId"] : @"";
      long long a = [o[@"at"] respondsToSelector:@selector(longLongValue)] ? [o[@"at"] longLongValue] : 0;
      if (g.length > 0 && a > 0 && a > byGroup[g].longLongValue) {
        byGroup[g] = @(a);
      }
    }
    if (at > byGroup[groupId].longLongValue) {
      byGroup[groupId] = @(at);
    }
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (NSString *g in byGroup) {
      NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"groupId" : g, @"at" : byGroup[g]}
                                                    options:0
                                                      error:nil];
      if (data != nil) {
        [lines addObject:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]];
      }
    }
    NSString *body = [[lines componentsJoinedByString:@"\n"] stringByAppendingString:@"\n"];
    [body writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSLog(@"[CanariPush] appendReadWatermark: group=%@ at=%lld recorded for the next boot", groupId, at);
  } @finally {
    [g_cacheLock unlock];
  }
}

/**
 * Announces "I have read this conversation up to `at`", from the notification shade. Android twin:
 * sendReadWatermark in CanariNotificationActionReceiver.kt, which carries the full reasoning.
 *
 * ONE ANSWER FOR BOTH ACTIONS: marking read and replying are the same acknowledgement (product
 * decision, 2026-08-31). `at` comes from the notification's own `userInfo`, never from a cache -
 * the id-based `read_receipt` this replaces read `fcm_message_cache.ndjson`, which the app CLEARS
 * at every boot, so "mark as read" sent NOTHING once the app had been opened since the notification
 * arrived. And never from the clock: watermarks merge by `max`, so a fast clock would mark future
 * messages read permanently and unfixably.
 */
static void CanariSendReadWatermark(NSString *groupId, long long at) {
  if (groupId.length == 0) {
    return;
  }
  if (at <= 0) {
    NSLog(@"[CanariPush] sendReadWatermark: no sentAt in userInfo group=%@ - nothing announced", groupId);
    return;
  }
  CanariAppendReadWatermark(groupId, at);

  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
    NSLog(@"[CanariPush] sendReadWatermark: push_context.json missing -> frame not queued");
    return;
  }
  char *protoPtr = canari_native_build_read_watermark_proto(at);
  if (protoPtr == nil) {
    NSLog(@"[CanariPush] sendReadWatermark: canari_native_build_read_watermark_proto failed");
    return;
  }
  NSString *protoB64 = [NSString stringWithUTF8String:protoPtr];
  canari_free_string(protoPtr);
  if (protoB64.length == 0) {
    return;
  }

  CanariOutboxEntry *entry = [[CanariOutboxEntry alloc] init];
  entry.entryId = [[NSUUID UUID] UUIDString];
  entry.groupId = groupId;
  entry.proto = protoB64;
  entry.sentAt = (long long)([[NSDate date] timeIntervalSince1970] * 1000);
  // Silent, but durable: a read watermark sent from the notification shade is the same mutation as
  // one sent from the app, and must reach a device that was offline.
  entry.silent = YES;
  entry.durable = YES;
  NSMutableArray<CanariOutboxEntry *> *entries = [CanariReadOutboxMirror() mutableCopy];
  [entries addObject:entry];
  CanariRewriteOutboxMirror(entries);
  CanariDrainOutboxBackground(ctx);
  NSLog(@"[CanariPush] sendReadWatermark: queued+drained at=%lld group=%@", at, groupId);
}

/// `CallEndReason.CALL_END_REASON_DECLINED` in libs/proto/canari.proto: the callee refused the ring.
static const unsigned int kCanariCallEndReasonDeclined = 2;

/**
 * Tells the caller this phone DECLINED its call, from the CallKit Decline - the hangup the in-app
 * Decline sends (`CallMsg { hangup, end_reason = DECLINED }`), so the caller's ring ends at once and
 * its record reads "declined". Before, the CallKit Decline sent nothing and the caller rang out its
 * whole minute (1.5.2-alpha.1). Android twin: handleCallDecline in CanariNotificationActionReceiver.kt.
 *
 * SENT ONCE, NEVER QUEUED: it is a transport frame (silent, not durable, as the in-app send), and a
 * hangup replayed from the outbox mirror after its call ended would mean nothing. A failure is
 * logged and the caller rings out its window. Blocking (an FFI encrypt and a POST): call it off the
 * main queue.
 */
static void CanariSendCallDecline(NSString *groupId, NSString *callId) {
  if (groupId.length == 0 || callId.length == 0) {
    NSLog(@"[CanariCallKit] ERROR decline with no group or call - the caller is not told");
    return;
  }
  CanariPushContext *ctx = CanariLoadPushContext();
  NSString *secret = CanariRetrievePushSecret();
  if (ctx == nil || secret == nil) {
    NSLog(@"[CanariCallKit] ERROR decline call=%@: push context or secret absent - the caller is "
          @"not told",
          callId);
    return;
  }
  NSString *messageId = [[NSUUID UUID] UUIDString];
  long long sentAt = (long long)([[NSDate date] timeIntervalSince1970] * 1000);
  char *protoPtr = canari_native_build_call_hangup_proto(
      messageId.UTF8String, sentAt, callId.UTF8String, ctx.deviceId.UTF8String,
      kCanariCallEndReasonDeclined);
  if (protoPtr == nil) {
    NSLog(@"[CanariCallKit] ERROR decline call=%@: the hangup could not be built", callId);
    return;
  }
  NSString *protoB64 = [NSString stringWithUTF8String:protoPtr];
  canari_free_string(protoPtr);
  if (protoB64.length == 0) {
    NSLog(@"[CanariCallKit] ERROR decline call=%@: the hangup could not be built", callId);
    return;
  }
  CanariOutboxEntry *entry = [[CanariOutboxEntry alloc] init];
  entry.entryId = messageId;
  entry.groupId = groupId;
  entry.proto = protoB64;
  entry.sentAt = sentAt;
  entry.silent = YES;
  entry.durable = NO;
  NSString *ciphertext = CanariEncryptQueuedMessages(ctx, @[ entry ])[messageId];
  if (ciphertext == nil) {
    NSLog(@"[CanariCallKit] decline call=%@: encrypt failed - the caller rings out its window",
          callId);
    return;
  }
  BOOL sent = CanariSendQueuedMessagePush(ctx, secret, groupId, ciphertext, messageId, YES, NO);
  NSLog(@"[CanariCallKit] decline call=%@ sent=%d", callId, sent);
}

/**
 * Notification quick action (WP-XP-1): builds a plaintext text `AppMessage` proto for the typed
 * reply (via the Rust FFI, no TS runtime involved), queues it into the same `outbox_pending.ndjson`
 * mirror the composer writes to, and drains it immediately. The notification is cleared only once
 * actually delivered (drain returns 0 remaining) - a queued-but-undelivered reply must keep the
 * notification so the user can retry from the app. Android twin: handleReply in
 * CanariNotificationActionReceiver.kt.
 */
static void CanariHandleQuickReplyAction(NSString *groupId, NSString *text, long long notifiedAt) {
  if (groupId.length == 0 || text.length == 0) {
    NSLog(@"[CanariPush] handleQuickReplyAction: groupId/text missing");
    return;
  }
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
    NSLog(@"[CanariPush] handleQuickReplyAction: push_context.json absent -> abort");
    return;
  }
  NSString *messageId = [[NSUUID UUID] UUIDString];
  long long sentAt = (long long)([[NSDate date] timeIntervalSince1970] * 1000);
  char *protoPtr = canari_native_build_text_message_proto(messageId.UTF8String, sentAt, text.UTF8String);
  if (protoPtr == nil) {
    NSLog(@"[CanariPush] handleQuickReplyAction: nativeBuildTextMessageProto failed");
    return;
  }
  NSString *protoB64 = [NSString stringWithUTF8String:protoPtr];
  canari_free_string(protoPtr);
  if (protoB64.length == 0) {
    return;
  }

  CanariOutboxEntry *entry = [[CanariOutboxEntry alloc] init];
  entry.entryId = messageId;
  entry.groupId = groupId;
  entry.proto = protoB64;
  entry.sentAt = sentAt;
  entry.silent = NO;
  entry.durable = YES;
  NSMutableArray<CanariOutboxEntry *> *entries = [CanariReadOutboxMirror() mutableCopy];
  [entries addObject:entry];
  CanariRewriteOutboxMirror(entries);
  NSLog(@"[CanariPush] handleQuickReplyAction: queued id=%@ group=%@",
        [messageId substringToIndex:MIN((NSUInteger)8, messageId.length)], groupId);

  int remaining = CanariDrainOutboxBackground(ctx);
  if (remaining == 0) {
    // Delivered: record it locally BEFORE clearing the notification, so the one visible trace of
    // the reply is never dropped before the durable one exists.
    CanariWriteSentMessageToCache(groupId, ctx.userId, messageId, text, sentAt);
    CanariCancelConversationNotification(groupId, nil);
    // ANSWERING A CONVERSATION IS READING IT (product decision, 2026-08-31). Only on the delivered
    // branch: a reply still sitting in the outbox has not been seen by anyone, and announcing a
    // read state for it would state something no peer can yet corroborate.
    CanariSendReadWatermark(groupId, notifiedAt);
  } else {
    // Not delivered: NO cache entry, or the app would show as sent a message that never left.
    // The notification stays up, which is the only retry affordance - `store_outbox_mirror`
    // rewrites outbox_pending.ndjson from the TypeScript queue, so this entry is wiped by the
    // next foreground outbox mutation rather than flushed (WP-NOTIF-1).
    NSLog(@"[CanariPush] handleQuickReplyAction: reply still queued (remaining=%d) - notification left as-is, entry NOT persisted",
          remaining);
  }
}

/**
 * Notification quick action (WP-XP-1): clears this device's local notification immediately (the
 * visible half of "mark as read"), then announces the watermark the notification carries.
 *
 * The notification is cleared FIRST and unconditionally: it is the half the user asked for and can
 * see, and it must not depend on the push context being loadable.
 */
static void CanariHandleMarkReadAction(NSString *groupId, long long sentAt) {
  if (groupId.length == 0) {
    return;
  }
  CanariCancelConversationNotification(groupId, nil);
  CanariSendReadWatermark(groupId, sentAt);
}

/// The `sentAt` a notification carries, or 0. APNs delivers `userInfo` values as `NSNumber` when
/// the app posted the notification itself and as `NSString` when they came off the wire, so both
/// answer here rather than at the two call sites.
static long long CanariNotifiedSentAt(NSDictionary *userInfo) {
  id raw = userInfo[@"sentAt"];
  return [raw respondsToSelector:@selector(longLongValue)] ? [raw longLongValue] : 0;
}

static void CanariShowPendingSyncNotification(void) {
  NSString *body = CanariLocalized(@"notif.outbox.pending");
  CanariShowLocalNotification(@"Canari", body, @"fr.emse.canari://chat", @"canari_messages",
                              kPendingSyncNotifId, nil, nil, NO, nil, 0, nil);
  NSLog(@"[CanariPush] showPendingSyncNotification");
}

static void CanariMaybeNotifyPendingSync(int remaining) {
  if (remaining <= 0) {
    return;
  }
  if (!canari_ios_is_in_foreground()) {
    CanariShowPendingSyncNotification();
  }
  // WP-XP-8: schedule automatic background retry via BGTaskScheduler
  CanariScheduleOutboxRetryTask();
}

static NSString *CanariAvatarCachePath(NSString *userId) {
  NSCharacterSet *allowed =
      [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"];
  NSMutableString *safe = [NSMutableString string];
  for (NSUInteger i = 0; i < userId.length && safe.length < 40; i++) {
    unichar c = [userId characterAtIndex:i];
    NSString *s = [NSString stringWithCharacters:&c length:1];
    if ([allowed characterIsMember:c]) {
      [safe appendString:s];
    } else {
      [safe appendString:@"_"];
    }
  }
  NSString *dir = CanariTauriDataDir();
  return [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"avatar_%@.jpg", safe]];
}

static NSString *_Nullable CanariFetchAvatar(CanariPushContext *ctx, NSString *userId) {
  if (userId.length == 0) {
    return nil;
  }
  NSString *cachePath = CanariAvatarCachePath(userId);
  NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:cachePath error:nil];
  if (attrs != nil) {
    NSDate *modified = attrs[NSFileModificationDate];
    if (modified != nil &&
        [[NSDate date] timeIntervalSinceDate:modified] < kAvatarCacheMaxAgeSec) {
      NSLog(@"[CanariPush] fetchAvatar: cache hit %@", userId);
      return cachePath;
    }
  }
  NSString *secret = CanariRetrievePushSecret();
  if (secret == nil) {
    return nil;
  }
  NSString *encodedUser =
      [userId stringByAddingPercentEncodingWithAllowedCharacters:
                    [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *encodedReq =
      [ctx.userId stringByAddingPercentEncodingWithAllowedCharacters:
                       [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *encodedDev =
      [ctx.deviceId stringByAddingPercentEncodingWithAllowedCharacters:
                        [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *urlStr = [NSString
      stringWithFormat:@"%@/api/mls/push/avatar/%@?requesterId=%@&deviceId=%@", ctx.baseUrl,
                       encodedUser, encodedReq, encodedDev];
  int status = 0;
  NSData *resp = CanariHttpRequest(@"GET", [NSURL URLWithString:urlStr], secret, nil, &status);
  if (status != 200 || resp == nil) {
    NSLog(@"[CanariPush] fetchAvatar: HTTP %d", status);
    return nil;
  }
  [resp writeToFile:cachePath atomically:YES];
  NSLog(@"[CanariPush] fetchAvatar: cached %@", userId);
  return cachePath;
}

/**
 * The disc drawn instead of a face when no avatar could be fetched, written to a temp PNG.
 *
 * Android has done this since the beginning (`generateInitialsBitmap`) and both iOS paths showed
 * NOTHING - so a notification whose avatar request failed, or whose sender simply has no photo,
 * arrived on an iPhone with a blank icon and on Android with a letter. This is the one piece of the
 * reaction rework that was judged not worth writing blind at the time; it is additive and guarded,
 * so a failure here costs exactly the icon and never the notification.
 *
 * `kCanariInitialsSize` is 192 where Android's bitmap is 96: an Android large icon is a small
 * square, an iOS attachment is rendered at banner size. The colour and the 0.4 letter ratio are
 * Android's, so the two platforms look like one product. The NSE has its own copy of this in Swift
 * (`initialsImageUrl`) - the appex is a separate bundle and shares no code with the app.
 *
 * The letter is a COMPOSED CHARACTER, not a UTF-16 unit: a name beginning with an emoji or with a
 * letter carrying a combining accent would otherwise be cut in half and drawn as a replacement box.
 * Android takes the first code unit and has that flaw; it is not worth reproducing.
 *
 * Written to `NSTemporaryDirectory` on purpose - the OS CONSUMES the file an attachment names, so
 * this must never be handed a path anything else needs afterwards.
 */
static NSString *_Nullable CanariInitialsImagePath(NSString *_Nullable name) {
  NSString *letter = @"?";
  if (name.length > 0) {
    NSRange first = [name rangeOfComposedCharacterSequenceAtIndex:0];
    letter = [[name substringWithRange:first] uppercaseString];
  }
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
  format.scale = 1;
  format.opaque = NO;
  CGFloat size = kCanariInitialsSize;
  UIGraphicsImageRenderer *renderer =
      [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(size, size) format:format];
  UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *_Nonnull ctx) {
    (void)ctx;
    [[UIColor colorWithRed:0x63 / 255.0 green:0x66 / 255.0 blue:0xf1 / 255.0 alpha:1.0] setFill];
    [[UIBezierPath bezierPathWithOvalInRect:CGRectMake(0, 0, size, size)] fill];
    NSDictionary *attrs = @{
      NSFontAttributeName : [UIFont systemFontOfSize:size * kCanariInitialsLetterRatio
                                              weight:UIFontWeightSemibold],
      NSForegroundColorAttributeName : [UIColor whiteColor],
    };
    CGSize textSize = [letter sizeWithAttributes:attrs];
    [letter drawAtPoint:CGPointMake((size - textSize.width) / 2.0, (size - textSize.height) / 2.0)
         withAttributes:attrs];
  }];
  NSData *png = UIImagePNGRepresentation(image);
  if (png == nil) {
    NSLog(@"[CanariPush] initialsImage: PNG encoding failed - notification goes out without an icon");
    return nil;
  }
  NSString *path = [NSTemporaryDirectory()
      stringByAppendingPathComponent:[NSString stringWithFormat:@"initials-%@.png",
                                                                [[NSUUID UUID] UUIDString]]];
  NSError *writeErr = nil;
  if (![png writeToFile:path options:NSDataWritingAtomic error:&writeErr]) {
    NSLog(@"[CanariPush] initialsImage: write failed: %@", CanariErrorReason(writeErr));
    return nil;
  }
  return path;
}

static void CanariProcessReceivedWelcomeBackground(NSString *groupId, NSString *_Nullable queuedMessageId,
                                                   NSString *_Nullable inlineProto) {
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: push_context absent");
    return;
  }
  if (ctx.deviceKeyB64.length == 0) {
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: deviceKeyB64 empty");
    return;
  }

  NSString *welcomeB64 = inlineProto;
  NSString *ratchetTreeB64 = @"";
  if (queuedMessageId.length > 0) {
    NSString *secret = CanariRetrievePushSecret();
    if (secret != nil) {
      NSString *fetchedWelcome = nil;
      NSString *fetchedTree = nil;
      CanariFetchWelcomeBundle(queuedMessageId, ctx, secret, &fetchedWelcome, &fetchedTree);
      if (welcomeB64.length == 0) {
        welcomeB64 = fetchedWelcome;
      }
      if (fetchedTree.length > 0) {
        ratchetTreeB64 = fetchedTree;
      }
    }
  }
  if (welcomeB64.length == 0) {
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: welcome absent");
    return;
  }

  if (![g_mlsStateLock tryLock]) {
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: MlsStateLock busy");
    return;
  }
  BOOL joined = NO;
  @try {
    NSString *dir = CanariTauriDataDir();
    NSData *stateBytes = CanariLoadMlsState();
    if (dir == nil || stateBytes == nil) {
      NSLog(@"[CanariPush] processReceivedWelcomeBackground: mls.bin absent");
      return;
    }
    joined = canari_native_process_welcome_background(
                 dir.UTF8String, (const unsigned char *)stateBytes.bytes, stateBytes.length,
                 ctx.deviceKeyB64.UTF8String, ctx.userId.UTF8String, ctx.deviceId.UTF8String,
                 welcomeB64.UTF8String, ratchetTreeB64.UTF8String) == 1;
  } @finally {
    [g_mlsStateLock unlock];
  }

  if (joined) {
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: groupe rejoint %@", groupId);
    NSString *secret = CanariRetrievePushSecret();
    if (secret != nil) {
      CanariMarkMembershipActive(ctx, secret, groupId);
    }
    CanariRunBackgroundCleanup();
  } else {
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: join failed %@", groupId);
  }

  int remaining = CanariDrainOutboxBackground(ctx);
  CanariMaybeNotifyPendingSync(remaining);
}

// Maps a media MIME type to a file extension so iOS infers the attachment type.
static NSString *CanariMimeExtension(NSString *_Nullable mime) {
  if ([mime isEqualToString:@"image/png"]) return @"png";
  if ([mime isEqualToString:@"image/gif"]) return @"gif";
  if ([mime isEqualToString:@"image/webp"]) return @"webp";
  return @"jpg";
}

// Downloads and decrypts an image/GIF blob for a notification thumbnail (WP-XP-3), writing the
// plaintext to a unique temp file. The media service stores only opaque AES-256-GCM ciphertext; the
// CEK/IV come from the MLS-decrypted MediaMsg (never the server). Fetched via the PushSecret-authed
// proxy (2 MB cap) and decrypted natively. Returns a local file path, or nil (text-only fallback).
static NSString *_Nullable CanariFetchAndDecryptMedia(CanariPushContext *ctx,
                                                      CanariDecryptedMessage *decrypted) {
  if (![decrypted.mediaKind isEqualToString:@"image"] || decrypted.mediaId.length == 0 ||
      decrypted.mediaKey.length == 0 || decrypted.mediaIv.length == 0) {
    return nil;
  }
  NSString *secret = CanariRetrievePushSecret();
  if (secret == nil) {
    return nil;
  }
  NSCharacterSet *q = [NSCharacterSet URLQueryAllowedCharacterSet];
  NSString *urlStr = [NSString
      stringWithFormat:@"%@/api/mls/push/media/%@?requesterId=%@&deviceId=%@", ctx.baseUrl,
                       [decrypted.mediaId stringByAddingPercentEncodingWithAllowedCharacters:q],
                       [ctx.userId stringByAddingPercentEncodingWithAllowedCharacters:q],
                       [ctx.deviceId stringByAddingPercentEncodingWithAllowedCharacters:q]];
  int status = 0;
  NSData *cipher = CanariHttpRequest(@"GET", [NSURL URLWithString:urlStr], secret, nil, &status);
  if (status != 200 || cipher.length == 0) {
    NSLog(@"[CanariPush] fetchAndDecryptMedia: HTTP %d", status);
    return nil;
  }

  size_t outLen = 0;
  unsigned char *plain = canari_native_decrypt_media(
      decrypted.mediaKey.UTF8String, decrypted.mediaIv.UTF8String,
      (const unsigned char *)cipher.bytes, cipher.length, &outLen);
  if (plain == nullptr || outLen == 0) {
    NSLog(@"[CanariPush] fetchAndDecryptMedia: native decrypt failed");
    return nil;
  }
  NSData *plaintext = [NSData dataWithBytes:plain length:outLen];
  canari_free_bytes(plain, outLen);

  NSString *tmpPath = [NSTemporaryDirectory()
      stringByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@", [[NSUUID UUID] UUIDString],
                                                                CanariMimeExtension(decrypted.mimeType)]];
  if (![plaintext writeToFile:tmpPath atomically:YES]) {
    return nil;
  }
  NSLog(@"[CanariPush] fetchAndDecryptMedia: thumbnail ready (%luB)", (unsigned long)plaintext.length);
  return tmpPath;
}

// The `names` map of `display_names.json` in the app's data directory, or nil when it cannot be
// used: absent, unreadable, or written for another account than `me` (one file per install, and two
// accounts may sign in on one phone). Written by `store_display_names` (Rust).
static NSDictionary *_Nullable CanariLoadMentionNames(NSString *_Nullable me) {
  NSString *dir = CanariTauriDataDir();
  if (me.length == 0 || dir == nil) {
    return nil;
  }
  NSData *data = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"display_names.json"]];
  if (data == nil) {
    NSLog(@"[CanariPush] [MENTION_NAME] no display_names.json - every other mention is 'someone'");
    return nil;
  }
  id root = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![root isKindOfClass:[NSDictionary class]]) {
    NSLog(@"[CanariPush] [MENTION_NAME] display_names.json unreadable");
    return nil;
  }
  id owner = ((NSDictionary *)root)[@"userId"];
  if (![owner isKindOfClass:[NSString class]] || ![[owner lowercaseString] isEqualToString:me]) {
    NSLog(@"[CanariPush] [MENTION_NAME] display_names.json belongs to another account - not used");
    return nil;
  }
  id names = ((NSDictionary *)root)[@"names"];
  return [names isKindOfClass:[NSDictionary class]] ? names : nil;
}

// The phone's names for ONE banner: `display_names.json` is read on the first call only, so the
// author line and the tokens of one banner cost one file read, and a banner needing neither none.
typedef NSDictionary *_Nullable (^CanariMentionNameBook)(void);
static CanariMentionNameBook CanariMakeMentionNameBook(NSString *_Nullable myUserId) {
  NSString *me = myUserId.lowercaseString;
  __block NSDictionary *names = nil;
  __block BOOL read = NO;
  return ^NSDictionary *_Nullable {
    if (!read) {
      names = CanariLoadMentionNames(me);
      read = YES;
    }
    return names;
  };
}

// "Alice mentioned you" for a salon banner that mentions this reader (WP-MENTION-NAME, 2026-10-18):
// the AUTHOR, named from the phone's own copy of names under the same owner rule as the tokens, and
// "Someone" when the phone has never named them. Never from the push, which carries only
// `senderId`. Salon only: an MLS banner already names its sender. Twins: the NSE's and Android's
// `mentionAuthorLine`.
static NSString *CanariMentionAuthorLine(NSString *senderId, CanariMentionNameBook nameBook) {
  NSString *idLower = senderId.lowercaseString;
  id name = idLower.length > 0 ? nameBook()[idLower] : nil;
  BOOL known = [name isKindOfClass:[NSString class]] && [(NSString *)name length] > 0;
  NSLog(@"[CanariPush] [MENTION_NAME] author named=%d", known);
  // The placeholder opens the sentence in both languages, so the word is capitalised there.
  NSString *someone = CanariLocalized(@"notif.mention.someone");
  NSString *who = known ? (NSString *)name
                        : (someone.length > 0
                               ? [[[someone substringToIndex:1] uppercaseString]
                                     stringByAppendingString:[someone substringFromIndex:1]]
                               : someone);
  return [NSString stringWithFormat:CanariLocalized(@"notif.social.mention.title"), who];
}

// Replaces the `@[<64 hex>]` mention tokens a decrypted body carries with something readable - "you"
// for this device's own user, the NAME the phone already holds for anybody else, and the word
// "someone" for an id it has never named - and collapses the run of spaces a token left. The names
// come from the phone's own copy (`nameBook`, shared with `CanariMentionAuthorLine` so one banner
// reads the file once), never from the push or the network (WP-MENTION-NAME, 2026-10-18). Twins:
// the NSE's `renderMentions` and Android's `renderMentions`.
static NSString *CanariRenderMentions(NSString *text, NSString *_Nullable myUserId,
                                      CanariMentionNameBook nameBook) {
  if (text.length == 0 || [text rangeOfString:@"@["].location == NSNotFound) {
    return text;
  }
  NSRegularExpression *regex =
      [NSRegularExpression regularExpressionWithPattern:@"@\\[([0-9a-fA-F]{64})\\]" options:0 error:nil];
  if (regex == nil) {
    return text;
  }
  NSString *me = myUserId.lowercaseString;
  NSMutableString *out = [NSMutableString string];
  NSUInteger cursor = 0;
  NSUInteger named = 0;
  NSUInteger unknown = 0;
  for (NSTextCheckingResult *match in [regex matchesInString:text options:0 range:NSMakeRange(0, text.length)]) {
    [out appendString:[text substringWithRange:NSMakeRange(cursor, match.range.location - cursor)]];
    NSString *mentioned = [[text substringWithRange:[match rangeAtIndex:1]] lowercaseString];
    BOOL isMe = me.length > 0 && [mentioned isEqualToString:me];
    [out appendString:@"@"];
    if (isMe) {
      [out appendString:CanariLocalized(@"notif.mention.you")];
    } else {
      // Read only when a token names somebody else.
      id name = nameBook()[mentioned];
      if ([name isKindOfClass:[NSString class]] && [(NSString *)name length] > 0) {
        named++;
        [out appendString:name];
      } else {
        unknown++;
        [out appendString:CanariLocalized(@"notif.mention.someone")];
      }
    }
    cursor = match.range.location + match.range.length;
  }
  [out appendString:[text substringFromIndex:cursor]];
  if (named + unknown > 0) {
    NSLog(@"[CanariPush] [MENTION_NAME] named=%lu unknown=%lu", (unsigned long)named,
          (unsigned long)unknown);
  }
  return [out stringByReplacingOccurrencesOfString:@"[ \\t]{2,}"
                                        withString:@" "
                                           options:NSRegularExpressionSearch
                                             range:NSMakeRange(0, out.length)];
}

// `mentionedByServer` is the channel path's answer to "does this @ me": a channel message carries a
// cleartext `mentionedUserIds` from the sender, so the server computes it per recipient. An MLS
// message has no such list - the server cannot read it - which is why the body scan below exists.
// Two paths, one question, each answered from where the answer actually is.
//
// `initialsName` is whose letter is drawn when no avatar can be fetched, and it is a PARAMETER
// because only the caller knows: a DM draws the sender, a salon draws the SALON (Android does the
// same), and the title this function composes is no help - for a salon it is
// `<Communaute> - #<salon>`, whose first character would be the community's, or a `#`.
//
// `namesMentionAuthor` is YES on the SALON path only: its title is the salon, so a mention of this
// reader names its author in the subtitle (`CanariMentionAuthorLine`, WP-MENTION-NAME). An MLS
// banner passes NO - its push already names the sender in the title or the subtitle.
//
// `scansBodyForMention` is YES on the MLS path only. The salon caller has already DECIDED the
// mention (`mentionedByServer` is its answer, and NO on a blind banner, which nothing proved), and a
// scan of a blind banner's body would read the generic line, whose salon name the server wrote -
// a salon named `@[<id>]` would mention that reader again.
static void CanariShowMessageNotification(NSString *senderName, NSString *groupName, NSString *body,
                                          NSString *groupId, NSString *senderId,
                                          CanariDecryptedMessage *_Nullable decrypted,
                                          BOOL mentionedByServer, NSString *_Nullable initialsName,
                                          BOOL namesMentionAuthor, BOOL scansBodyForMention) {
  if (canari_ios_is_in_foreground()) {
    return;
  }
  BOOL isGroup = groupName.length > 0 && ![groupName isEqualToString:senderName];
  NSString *title = isGroup ? groupName : (senderName.length > 0 ? senderName : @"Canari");
  NSString *deepLink =
      (groupId.length > 0 ? CanariChatLink(groupId, @"") : nil) ?: @"fr.emse.canari://chat";
  int notifId = CanariStableNotifId(groupId);
  // Attachment priority: a media thumbnail (WP-XP-3) outranks the sender avatar, since iOS shows only
  // the first image attachment as the banner preview. Fall back to the avatar for text/non-image.
  NSString *attachmentPath = nil;
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx != nil && decrypted != nil) {
    attachmentPath = CanariFetchAndDecryptMedia(ctx, decrypted);
  }
  if (attachmentPath == nil && ctx != nil && senderId.length > 0) {
    attachmentPath = CanariFetchAvatar(ctx, senderId);
  }
  // Last: the initials disc, so a notification is never iconless. It must stay BELOW the media
  // thumbnail - iOS renders only the first attachment, and a letter replacing the picture the
  // message is about would be a regression, not a fallback.
  if (attachmentPath == nil) {
    attachmentPath = CanariInitialsImagePath(initialsName);
  }
  // @-mention of me (WP-XP-5): the decrypted body carries inline `@[uuid]` tokens; when one
  // targets my own userId the notification is delivered time-sensitive (Focus breakthrough).
  BOOL mentionsMe = mentionedByServer;
  if (scansBodyForMention && !mentionsMe && ctx != nil && ctx.userId.length > 0 && body.length > 0) {
    NSString *needle = [NSString stringWithFormat:@"@[%@]", ctx.userId];
    mentionsMe = [body rangeOfString:needle options:NSCaseInsensitiveSearch].location != NSNotFound;
  }
  // WP-XP-7: per-conversation stacking via threadIdentifier = groupId (Android twin:
  // MessagingStyle with per-conversation notifId). NSE already does this for the killed-app path.
  NSString *threadId = groupId.length > 0 ? groupId : @"canari_messages";
  // Inside a group conversation, surface who spoke as a subtitle (Android: MessagingStyle.Message
  // already carries the sender Person). NSE twin: applyMessageContent in NotificationService.swift.
  NSString *subtitle = isGroup ? senderName : nil;
  // The phone's names, read at most once for this banner: the author line and the tokens share it.
  CanariMentionNameBook nameBook = CanariMakeMentionNameBook(ctx != nil ? ctx.userId : nil);
  if (namesMentionAuthor && mentionsMe) {
    subtitle = CanariMentionAuthorLine(senderId, nameBook);
  }
  // Rendered for DISPLAY only, after the mention-of-me scan above has read the raw tokens.
  NSString *shown = CanariRenderMentions(body, ctx != nil ? ctx.userId : nil, nameBook);
  CanariShowLocalNotification(title, shown, deepLink, threadId, notifId, attachmentPath,
                              groupId, mentionsMe, subtitle, decrypted != nil ? decrypted.sentAt : 0,
                              mentionsMe ? kCanariSoundMention : kCanariSoundMessage);
}

static void CanariRefreshTokenOnBackend(CanariPushContext *ctx, NSString *secret, NSString *token) {
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/refresh-token", ctx.baseUrl]];
  if (url == nil) {
    return;
  }
  NSDictionary *payload = @{@"userId" : ctx.userId, @"deviceId" : ctx.deviceId, @"token" : token};
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (body == nil) {
    return;
  }
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
  req.HTTPMethod = @"POST";
  req.HTTPBody = body;
  [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  [req setValue:[NSString stringWithFormat:@"PushSecret %@", secret] forHTTPHeaderField:@"Authorization"];
  req.timeoutInterval = 5.0;
  [[[NSURLSession sharedSession] dataTaskWithRequest:req] resume];
}

// --- Incoming-call ring: PushKit VoIP + CallKit (WP-XP-5) --------------------
//
// The ring path is CLEARTEXT and explicit: the caller's client hits POST /api/calls/ring and the
// backend fans out a direct APNs VoIP push (FCM cannot carry `apns-push-type: voip`) with
// {type:"call_ring", groupId, callId, callerId, hasVideo, ringUntil} - ids and the server's answer
// deadline, never a name (decision 6; the name is resolved here from the phone's copy). The server
// sends it only while the ring is live, to a member whose call permission allows it, across no
// block, with calls_mode open (calls.md, "The native ring on the iPhone"). PushKit launches this app
// even from a killed state and Apple REQUIRES every VoIP push to immediately report a call to
// CallKit - the full-screen system ring UI. Answering cannot start audio directly (the MLS/WebRTC
// stack lives in the webview behind the PIN lock), so an answer records a pending accept
// (pending_call_accept.json, drained by the frontend after unlock via the
// `read_and_clear_pending_call_accept` Tauri command) and the CallKit session is closed as soon as
// the app becomes active - the in-app call UI takes over from there.

/// Mirrors CALLS_NATIVE_RING_COMPILED in frontend/src/lib/features.ts (CALLS_COMPILED until
/// 2026-10-21; callsCompiled.test.ts asserts it), which compiles the native ring - PushKit and
/// CallKit - into the build; ON since the owner's decision of 2026-10-30 (it ships in 1.5.2, its
/// hardware readings K6/K7/K8 owed on calls.md). It is duplicated rather than read from JS because
/// this code runs BEFORE the webview exists - a PushKit registry is installed at process start, and
/// there is nothing to ask. The two move in the same commit, together with the `voip`
/// UIBackgroundModes entry of Info.plist: without that entry PKPushRegistry can never obtain a
/// token, so installing it here would be a permanent silent failure rather than a feature.
static const BOOL kCanariCallsEnabled = YES;

static NSString *const kVoipTokenFileName = @"voip_token.txt";
static NSString *const kPendingCallAcceptFileName = @"pending_call_accept.json";
static const int64_t kCallRingTimeoutSec = 60;

static CXProvider *g_callProvider = nil;
static PKPushRegistry *g_voipRegistry = nil;
/// callId -> CallKit UUID for calls currently ringing (or answered but not yet handed over).
static NSMutableDictionary<NSString *, NSUUID *> *g_ringingCalls = nil;
/// CallKit UUID string -> {groupId, callId, callerId, hasVideo, answered?} for the answer and end
/// handlers: the answer carries all of it to the webview, the end reads `answered` to tell a decline.
static NSMutableDictionary<NSString *, NSDictionary *> *g_ringingCallInfo = nil;

/// The answered CallKit calls whose answer the page has not been told of yet, by CallKit UUID - the
/// answer's facts, kept PAST the ringing entry. The handover's End (`CanariEndCallKitCallFor`, async)
/// removes `g_ringingCallInfo`; a user's End delivered after it but before the Tell must still know
/// the call was answered, to cancel the file. Emptied by the Tell, once the page holds the answer -
/// and by any OTHER end of the call (`CanariEndCallKitCall`): a call ended remotely, elsewhere or at
/// its ring's deadline is gone from CallKit, so no End of it can follow, and its record would
/// otherwise outlive it (review of #2785).
static NSMutableDictionary<NSString *, NSDictionary *> *CanariAnsweredUntilTold(void) {
  static NSMutableDictionary<NSString *, NSDictionary *> *answered = nil;
  if (answered == nil) {
    answered = [NSMutableDictionary dictionary];
  }
  return answered;
}

/// Ends a CallKit session for `callId`. No-op when the call is not currently reported.
///
/// `forHandover` is YES for the handover's own end alone (`CanariHandOverCallsToPage`): it keeps the
/// answer's record until the page is told, so a user's End landing in between still cancels the
/// answer. Every other end - remote hangup, `call_ring_end`, the ring's deadline - drops it: CallKit
/// sends no End for a call already ended.
static void CanariEndCallKitCallFor(NSString *callId, CXCallEndedReason reason, BOOL forHandover) {
  if (callId.length == 0) {
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    NSUUID *uuid = g_ringingCalls[callId];
    if (uuid == nil) {
      return;
    }
    [g_ringingCalls removeObjectForKey:callId];
    [g_ringingCallInfo removeObjectForKey:uuid.UUIDString];
    if (!forHandover && CanariAnsweredUntilTold()[uuid.UUIDString] != nil) {
      [CanariAnsweredUntilTold() removeObjectForKey:uuid.UUIDString];
      NSLog(@"[CanariCallKit] call %@ ended before its answer was handed over - its record dropped",
            callId);
    }
    [g_callProvider reportCallWithUUID:uuid endedAtDate:nil reason:reason];
    NSLog(@"[CanariCallKit] call %@ ended (reason=%ld)", callId, (long)reason);
  });
}

/// Ends a CallKit session for `callId` from anywhere but the handover (remote hangup, answered
/// elsewhere, the ring's deadline) - see `CanariEndCallKitCallFor`.
static void CanariEndCallKitCall(NSString *callId, CXCallEndedReason reason) {
  CanariEndCallKitCallFor(callId, reason, NO);
}

/// The ring's deadline reached a call CallKit may still show. An UNANSWERED one rang out. An
/// ANSWERED one did not: the user took it, and the page never took it over (the app was not made
/// active in time) - so it is never ended `Unanswered`, which names a call nobody took (and, by
/// reading, not observation, likely files it as missed in Recents). It is ended `Failed`: the ring's window is the answer's (the server's `room-token`
/// refuses a join past its deadline with 410 - the VoIP ring follows that deadline, the FCM ring
/// approximates it with `kCallRingTimeoutSec`), and a session left open would show a green bar for
/// a call nobody can join. Its pending accept is kept, so the page, once opened, joins if the server
/// still lets it and otherwise says the call is over itself.
static void CanariEndCallKitCallAtRingDeadline(NSString *callId, NSUUID *uuid) {
  if (![g_ringingCalls[callId] isEqual:uuid]) {
    return;  // ended, or handed over, before its deadline
  }
  if ([g_ringingCallInfo[uuid.UUIDString][@"answered"] boolValue]) {
    NSLog(@"[CanariCallKit] call=%@ answered but not taken over by the page by the ring's deadline "
          @"- ended as failed, never as unanswered",
          callId);
    CanariEndCallKitCall(callId, CXCallEndedReasonFailed);
    return;
  }
  NSLog(@"[CanariCallKit] call=%@ rang out unanswered - ended", callId);
  CanariEndCallKitCall(callId, CXCallEndedReasonUnanswered);
}

/// Removes the pending accept the CallKit answer wrote, when it names `callId` (an End after the
/// answer). Read before the removal, so the answer of another call is never the one dropped.
static void CanariCancelPendingCallAccept(NSString *callId) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil || callId.length == 0) {
    NSLog(@"[CanariCallKit] ERROR cancel of the answer of call=%@: no data dir or call", callId);
    return;
  }
  NSString *path = [dir stringByAppendingPathComponent:kPendingCallAcceptFileName];
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (data == nil) {
    NSLog(@"[CanariCallKit] answer of call=%@ ended - no pending accept left to cancel", callId);
    return;
  }
  id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  id pendingCall = [json isKindOfClass:[NSDictionary class]] ? ((NSDictionary *)json)[@"callId"] : nil;
  if (![pendingCall isKindOfClass:[NSString class]] || ![pendingCall isEqualToString:callId]) {
    NSLog(@"[CanariCallKit] answer of call=%@ ended - the pending accept names another call, kept",
          callId);
    return;
  }
  NSError *err = nil;
  if (![[NSFileManager defaultManager] removeItemAtPath:path error:&err]) {
    NSLog(@"[CanariCallKit] ERROR the pending accept of call=%@ could not be removed: %@", callId,
          CanariErrorReason(err));
    return;
  }
  NSLog(@"[CanariCallKit] answer of call=%@ cancelled by the End - pending accept removed", callId);
}

/// Tells a live page that the CallKit answer's `pending_call_accept.json` waits -
/// `canari:call-accept`, on which the page drains it (`drainNativePendingCallAccept`). A page not
/// loaded yet drains it at its mount instead. A STAT, never a read: nothing is told when no answer
/// waits.
///
/// AN EVENT, BECAUSE THE PAGE SEES NO TRANSITION. PushKit launches a killed app in the background,
/// and WKWebView loads the page `visible` and keeps it so until the app has been active and left:
/// on the iPhone 12 (1.5.2-alpha.2, K7 and K8) the page went `0 -> 1` at the launch and never
/// changed when the answer brought the app to the front, so no `visibilitychange` drained the file
/// and the call was never joined. The deep link of 1.5.2-alpha.1 was the trigger that hid this; a
/// link no longer answers (calls.md, "An answer from the ring joins on the ring's facts").
///
/// CALLED AT THE HANDOVER, NEVER AT THE ANSWER: until the app is active a CallKit End may still
/// cancel the answer (`CanariCancelPendingCallAccept` removes the file), and the page must not
/// already hold it in memory then.
static void CanariTellPageOfPendingCallAccept(void) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil ||
      ![[NSFileManager defaultManager]
          fileExistsAtPath:[dir stringByAppendingPathComponent:kPendingCallAcceptFileName]]) {
    return;
  }
  WKWebView *webView = CanariFindWebView();
  if (webView == nil) {
    NSLog(@"[CanariCallKit] an answer waits before the WebView: the page drains it at mount");
    return;
  }
  [webView evaluateJavaScript:@"window.dispatchEvent(new CustomEvent('canari:call-accept'));"
            completionHandler:^(__unused id result, NSError *error) {
              // Said once the page ran the dispatch, never before: either line is a fact.
              if (error != nil) {
                NSLog(@"[CanariCallKit] ERROR the page was not told of the answer (%@): it drains "
                      @"at its next mount or resume",
                      CanariErrorReason(error));
                return;
              }
              NSLog(@"[CanariCallKit] an answer waits - the page was told");
            }];
}

/// Whether the open app rings this call itself, so CallKit stands back: the app is in front AND
/// the page holds the gateway socket the caller's invite arrives on (Rust `page_ring`). In front at
/// the PIN gate the page holds none, the server skips the invite, and CallKit is the only ring -
/// standing back there rang nothing at all (the Android reading of 1.5.2-alpha.3, same shape).
static BOOL CanariForegroundPageRings(void) {
  return canari_ios_is_in_foreground() && canari_ios_page_rings_in_app();
}

/// THE HANDOVER: once the app is active, the page owns an ANSWERED call. Each answered CallKit call
/// is ended `AnsweredElsewhere` (a session left open would show a dangling green bar), THEN the page
/// is told an answer waits - queued on the main queue behind those ends. Run on `didBecomeActive`,
/// and at an Answer made while the app is already active (the PIN gate in front), which no
/// activation follows.
///
/// AN UNANSWERED RING IS NOT HANDED OVER unless the page is ringing THAT call (`page_ring`: its
/// `CallService` is `incoming` on it). At the PIN gate the page cannot ring it (the invite was
/// skipped), so ending it would end the call's only ring: a pull of Control Center over an app
/// ringing at the gate resigns and re-activates the app, and the caller rang out with nobody told.
/// Holding the gateway socket does not say it either: the unlock opens a socket AFTER the skipped
/// invite, and that page rings nothing (review of #2785). It ends by its own answer, decline,
/// `call_ring_end` or deadline. When the page rings it, the overlay owns the call and the CallKit
/// ring is ended.
///
/// Not idempotent by construction but by state: a second run finds the answered calls already
/// ended, an unanswered one judged the same way, and a drained file not there to tell.
static void CanariHandOverCallsToPage(NSString *why) {
  // The app is active here by construction: the page's own facts decide, not the foreground flag,
  // whose observer may not have run yet.
  NSLog(@"[CanariCallKit] handover to the page (%@)", why);
  NSMutableArray<NSString *> *toldUUIDs = [NSMutableArray array];
  for (NSString *callId in [g_ringingCalls.allKeys copy]) {
    NSString *uuid = g_ringingCalls[callId].UUIDString;
    BOOL answered = [g_ringingCallInfo[uuid][@"answered"] boolValue];
    if (answered) {
      [toldUUIDs addObject:uuid];
    } else if (!canari_ios_page_rings_call(callId.UTF8String)) {
      NSLog(@"[CanariCallKit] call=%@ still rings unanswered and the page does not ring it - kept",
            callId);
      continue;
    } else {
      NSLog(@"[CanariCallKit] call=%@ rings in the page - its CallKit ring is ended", callId);
    }
    CanariEndCallKitCallFor(callId, CXCallEndedReasonAnsweredElsewhere, YES);
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    CanariTellPageOfPendingCallAccept();
    // Told (or the file was cancelled by an End that landed before this): no End of these calls
    // can cancel the answer from here on.
    [CanariAnsweredUntilTold() removeObjectsForKeys:toldUUIDs];
  });
}

@interface CanariCallProviderDelegate : NSObject <CXProviderDelegate>
@end

@implementation CanariCallProviderDelegate

- (void)providerDidReset:(CXProvider *)provider {
  (void)provider;
  [g_ringingCalls removeAllObjects];
  [g_ringingCallInfo removeAllObjects];
  [CanariAnsweredUntilTold() removeAllObjects];
  NSLog(@"[CanariCallKit] provider reset");
}

/// User answered on the system UI. Audio cannot start here (MLS keys are behind the PIN lock in
/// the webview), so persist the accept for the frontend and try to foreground the app; the CallKit
/// session is closed on didBecomeActive once the in-app flow takes over.
- (void)provider:(CXProvider *)provider performAnswerCallAction:(CXAnswerCallAction *)action {
  (void)provider;
  NSDictionary *info = g_ringingCallInfo[action.callUUID.UUIDString];
  NSString *groupId = info[@"groupId"] ?: @"";
  NSString *callId = info[@"callId"] ?: @"";
  NSString *callerId = info[@"callerId"] ?: @"";
  BOOL hasVideo = [info[@"hasVideo"] boolValue];
  NSLog(@"[CanariCallKit] answer call=%@ group=%@", callId, groupId);
  if (info != nil) {
    // Answered: an END of this CallKit call from now on is a hang-up of an answered call, never a
    // decline (performEndCallAction).
    NSMutableDictionary *answered = [info mutableCopy];
    answered[@"answered"] = @YES;
    g_ringingCallInfo[action.callUUID.UUIDString] = answered;
    // Kept past the ringing entry until the page is told (`CanariAnsweredUntilTold`).
    CanariAnsweredUntilTold()[action.callUUID.UUIDString] = answered;
  }

  // THE PENDING ACCEPT IS THE WHOLE ANSWER: every fact the join needs, from the ring. The webview
  // joins on it without waiting for the caller's MLS invite, a transport frame the server skipped
  // while this phone was closed (calls.md, "An answer from the ring joins on the ring's facts").
  NSString *dir = CanariTauriDataDir();
  if (dir != nil && groupId.length > 0) {
    NSDictionary *pending = @{
      @"groupId" : groupId,
      @"callId" : callId,
      @"callerId" : callerId,
      @"hasVideo" : @(hasVideo),
      @"acceptedAt" : @((long long)([[NSDate date] timeIntervalSince1970] * 1000)),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:pending options:0 error:nil];
    [json writeToFile:[dir stringByAppendingPathComponent:kPendingCallAcceptFileName]
           atomically:YES];
  }
  [action fulfill];

  // ANSWERED WITH THE APP ALREADY ACTIVE (the PIN gate in front, rung by CallKit because the page
  // held no socket): no `didBecomeActive` will follow, so the handover runs now - after the file is
  // written, so the page is told of an answer that exists.
  if ([UIApplication sharedApplication].applicationState == UIApplicationStateActive) {
    dispatch_async(dispatch_get_main_queue(), ^{
      CanariHandOverCallsToPage(@"answered with the app already active");
    });
  }

  // Best-effort foreground: works when the app is unlocked/active contexts allow it; from the
  // lock screen the user lands in the app via the CallKit UI's app button instead.
  if (groupId.length > 0) {
    // NAVIGATION ONLY: the answer is the private file above, never a parameter of a link.
    NSString *link = CanariChatLink(groupId, @"");
    NSURL *url = link != nil ? [NSURL URLWithString:link] : nil;
    if (url != nil) {
      dispatch_async(dispatch_get_main_queue(), ^{
        [[UIApplication sharedApplication] openURL:url options:@{} completionHandler:nil];
      });
    }
  }
}

/// The user ended the call on the system UI, and the caller is told (`CanariSendCallDecline`: the
/// in-app Decline's hangup), so its ring ends at once instead of after its whole window. Calls are
/// 1:1 (calls.md, lot 1), so declining and ending the caller's ring are one act.
///
/// AN END AFTER THE ANSWER CANCELS THE ANSWER. The answer wrote `pending_call_accept.json` for the
/// webview; ended now, that file is removed (`CanariCancelPendingCallAccept`), or an unlock in the
/// next minutes would join a call the user hung up. Nothing can be held in the webview's memory yet:
/// the page is told of the file only at the handover (`CanariTellPageOfPendingCallAccept`, queued
/// behind the AnsweredElsewhere ends), so no End can follow a drain. The caller is told as for a
/// decline - this device never joined.
- (void)provider:(CXProvider *)provider performEndCallAction:(CXEndCallAction *)action {
  (void)provider;
  NSString *uuid = action.callUUID.UUIDString;
  // An answered call the handover already ended (its ringing entry gone) is still known here until
  // the page is told: an End landing in that window must cancel the answer, never let it join.
  NSDictionary *info = g_ringingCallInfo[uuid] ?: CanariAnsweredUntilTold()[uuid];
  NSString *callId = info[@"callId"] ?: @"";
  NSString *groupId = info[@"groupId"] ?: @"";
  BOOL answered = [info[@"answered"] boolValue];
  NSLog(@"[CanariCallKit] %@ call=%@%@", answered ? @"ended after the answer" : @"declined", callId,
        g_ringingCallInfo[uuid] == nil && info != nil ? @" (after the handover's end, before the tell)"
                                                      : @"");
  if (callId.length > 0) {
    [g_ringingCalls removeObjectForKey:callId];
  }
  [g_ringingCallInfo removeObjectForKey:uuid];
  [CanariAnsweredUntilTold() removeObjectForKey:uuid];
  [action fulfill];
  if (answered) {
    CanariCancelPendingCallAccept(callId);
  }
  if (info != nil) {
    UIApplication *app = [UIApplication sharedApplication];
    __block UIBackgroundTaskIdentifier task = UIBackgroundTaskInvalid;
    task = [app beginBackgroundTaskWithName:@"canari-call-decline"
                          expirationHandler:^{
                            NSLog(@"[CanariCallKit] decline call=%@ ran out of background time",
                                  callId);
                            [app endBackgroundTask:task];
                            task = UIBackgroundTaskInvalid;
                          }];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CanariSendCallDecline(groupId, callId);
      dispatch_async(dispatch_get_main_queue(), ^{
        if (task != UIBackgroundTaskInvalid) {
          [app endBackgroundTask:task];
          task = UIBackgroundTaskInvalid;
        }
      });
    });
  }
}

@end

static CanariCallProviderDelegate *g_callProviderDelegate = nil;

/// Lazily creates the CXProvider (system call UI) shared by every ring.
static void CanariEnsureCallProvider(void) {
  if (g_callProvider != nil) {
    return;
  }
  g_ringingCalls = [NSMutableDictionary dictionary];
  g_ringingCallInfo = [NSMutableDictionary dictionary];
  CXProviderConfiguration *config = [[CXProviderConfiguration alloc] init];
  config.supportsVideo = YES;
  config.maximumCallGroups = 1;
  config.maximumCallsPerCallGroup = 1;
  config.supportedHandleTypes = [NSSet setWithObject:@(CXHandleTypeGeneric)];
  g_callProvider = [[CXProvider alloc] initWithConfiguration:config];
  g_callProviderDelegate = [[CanariCallProviderDelegate alloc] init];
  [g_callProvider setDelegate:g_callProviderDelegate queue:nil];
}

/// The caller's name for the CallKit screen, from THIS PHONE'S copy of names (`display_names.json`,
/// under the same owner rule as a mention, decision 6 of 2026-10-18), never from the push. A caller
/// the phone has never named shows the neutral "Canari call" - a person it shares no conversation
/// with is not somebody it should name.
static NSString *CanariCallerDisplayName(NSString *callerId) {
  CanariPushContext *ctx = CanariLoadPushContext();
  NSDictionary *names = CanariLoadMentionNames(ctx.userId.lowercaseString);
  id name = callerId.length > 0 ? names[callerId.lowercaseString] : nil;
  BOOL known = [name isKindOfClass:[NSString class]] && [(NSString *)name length] > 0;
  NSLog(@"[CanariCallKit] caller named=%d", known);
  return known ? (NSString *)name : CanariLocalized(@"notif.call.unknown_caller");
}

/// Reports an incoming call to CallKit (full-screen system ring). Deduped per callId (the VoIP
/// push and the FCM `call_ring` may both arrive); auto-ends as unanswered after 60s. A decrypted
/// MLS `call_invite` never comes here: the server's `call_ring` is the only ring.
///
/// The caller is named from this phone's own copy (`CanariCallerDisplayName`), never from the
/// frame: since the native ring shipped (2026-10-30) the `call_ring` FCM data carries ids only, and
/// one path naming the caller one way keeps the two rings of the same call identical.
static void CanariReportIncomingCall(NSString *groupId, NSString *callId, NSString *callerId,
                                     BOOL hasVideo) {
  if (callId.length == 0) {
    return;
  }
  // The switch is checked here, at the FCM `call_ring`'s ring: raising a system call UI for a
  // call the webview will refuse to join is worse than no ring at all.
  if (!kCanariCallsEnabled) {
    NSLog(@"[CanariCallKit] calls disabled - not reporting incoming call %@", callId);
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    CanariEnsureCallProvider();
    if (g_ringingCalls[callId] != nil) {
      NSLog(@"[CanariCallKit] call %@ already ringing - dedupe", callId);
      return;
    }
    NSUUID *uuid = [NSUUID UUID];
    g_ringingCalls[callId] = uuid;
    g_ringingCallInfo[uuid.UUIDString] = @{
      @"groupId" : groupId ?: @"",
      @"callId" : callId,
      @"callerId" : callerId ?: @"",
      @"hasVideo" : @(hasVideo),
    };

    CXCallUpdate *update = [[CXCallUpdate alloc] init];
    NSString *display = CanariCallerDisplayName(callerId);
    update.remoteHandle = [[CXHandle alloc] initWithType:CXHandleTypeGeneric value:display];
    update.localizedCallerName = display;
    update.hasVideo = hasVideo;
    update.supportsHolding = NO;
    update.supportsGrouping = NO;
    update.supportsUngrouping = NO;
    update.supportsDTMF = NO;

    [g_callProvider reportNewIncomingCallWithUUID:uuid
                                           update:update
                                       completion:^(NSError *_Nullable error) {
                                         if (error != nil) {
                                           NSLog(@"[CanariCallKit] report failed: %@",
                                                 CanariErrorReason(error));
                                           [g_ringingCalls removeObjectForKey:callId];
                                           [g_ringingCallInfo
                                               removeObjectForKey:uuid.UUIDString];
                                         } else {
                                           NSLog(@"[CanariCallKit] ringing call=%@ video=%d",
                                                 callId, hasVideo);
                                         }
                                       }];

    // Local ring timeout: CallKit has no built-in one. Only acts on a call still reported.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, kCallRingTimeoutSec * NSEC_PER_SEC),
                   dispatch_get_main_queue(), ^{
                     CanariEndCallKitCallAtRingDeadline(callId, uuid);
                   });
  });
}

/// Reports a VoIP-pushed call to CallKit, SYNCHRONOUSLY and on EVERY path (Apple's contract, see
/// `didReceiveIncomingPushWithPayload`). Must run on the main queue - the PushKit registry's.
///
/// - The ring ends at the SERVER'S answer deadline `ringUntilMs` (epoch ms, from the payload),
///   capped at `kCallRingTimeoutSec`: the window is the server's, so the phone does not keep ringing
///   for a call nobody can answer any more. A push that arrives past it (APNs held it while the phone
///   was off) is reported and ended at once - a flash, and the only thing Apple allows.
/// - A call already reported for `callId` (the FCM `call_ring` rang first) is reported AGAIN under the
///   same UUID: CallKit refuses it as a duplicate, which still honours the contract, and nothing
///   new rings.
/// - Audio only (`hasVideo = NO`) until the video lot decides how the native ring announces video.
static void CanariReportVoipCall(NSString *groupId, NSString *callId, NSString *callerId,
                                 long long ringUntilMs) {
  CanariEnsureCallProvider();
  if (!kCanariCallsEnabled) {
    // Unreachable by construction: the registry is installed only when the ring is compiled. The
    // report is still made, because the contract holds whatever this build believes.
    NSLog(@"[CanariCallKit] ERROR voip push on a build without the native ring - reported and ended");
    ringUntilMs = 0;
  } else if (CanariForegroundPageRings()) {
    // AN OPEN, SIGNED-IN APP ALREADY RINGS: the in-app overlay got the invite over the socket.
    // CallKit on top would ring the same call twice. Apple still requires the report, so it is
    // reported and ended at once - the past-deadline branch below, the one thing the contract allows.
    NSLog(@"[CanariCallKit] call=%@ voip push with the page holding the socket - the in-app overlay "
          @"rings; reported and ended",
          callId);
    ringUntilMs = 0;
  } else if (canari_ios_is_in_foreground()) {
    NSLog(@"[CanariCallKit] call=%@ voip push with the app in front and no socket (PIN gate) - "
          @"CallKit is the only ring",
          callId);
  }
  NSUUID *existing = g_ringingCalls[callId];
  NSUUID *uuid = existing ?: [NSUUID UUID];
  if (existing == nil) {
    g_ringingCalls[callId] = uuid;
    g_ringingCallInfo[uuid.UUIDString] = @{
      @"groupId" : groupId ?: @"",
      @"callId" : callId,
      @"callerId" : callerId ?: @"",
      @"hasVideo" : @NO,
    };
  }
  NSString *display = CanariCallerDisplayName(callerId);
  CXCallUpdate *update = [[CXCallUpdate alloc] init];
  update.remoteHandle = [[CXHandle alloc] initWithType:CXHandleTypeGeneric value:display];
  update.localizedCallerName = display;
  update.hasVideo = NO;
  update.supportsHolding = NO;
  update.supportsGrouping = NO;
  update.supportsUngrouping = NO;
  update.supportsDTMF = NO;

  long long nowMs = (long long)([[NSDate date] timeIntervalSince1970] * 1000);
  long long remainingMs = ringUntilMs - nowMs;
  // A call NOT TO RING (deadline passed, or rung in-app) is ended INSIDE the report's completion:
  // ending it before CallKit has taken the report races the report itself.
  BOOL endAtOnce = remainingMs <= 0;
  [g_callProvider reportNewIncomingCallWithUUID:uuid
                                         update:update
                                     completion:^(NSError *_Nullable error) {
                                       if (error == nil) {
                                         NSLog(@"[CanariCallKit] %@ call=%@ (voip, %lld ms left)",
                                               endAtOnce ? @"reported" : @"ringing", callId,
                                               remainingMs);
                                       } else {
                                         NSLog(@"[CanariCallKit] voip report refused call=%@ "
                                               @"duplicate=%d: %@",
                                               callId, existing != nil, CanariErrorReason(error));
                                         if (existing == nil) {
                                           [g_ringingCalls removeObjectForKey:callId];
                                           [g_ringingCallInfo removeObjectForKey:uuid.UUIDString];
                                         }
                                       }
                                       if (endAtOnce) {
                                         NSLog(@"[CanariCallKit] call=%@ voip push not to ring "
                                               @"(deadline passed, or rung in-app) - reported and "
                                               @"ended",
                                               callId);
                                         CanariEndCallKitCall(callId, CXCallEndedReasonRemoteEnded);
                                       }
                                     }];
  if (endAtOnce) {
    return;  // the completion ends it
  }
  if (existing != nil) {
    return;  // the first report armed its own end
  }
  long long ringMs = MIN(remainingMs, kCallRingTimeoutSec * 1000);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, ringMs * NSEC_PER_MSEC), dispatch_get_main_queue(),
                 ^{
                   CanariEndCallKitCallAtRingDeadline(callId, uuid);
                 });
}

/// Persists the PushKit VoIP token and re-registers it on the backend (voipToken column of the
/// device's push_token row) when a push context + secret already exist. Mirror of
/// CanariPersistFcmToken for the VoIP transport.
static void CanariPersistVoipToken(NSString *hexToken) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil || hexToken.length == 0) {
    return;
  }
  [hexToken writeToFile:[dir stringByAppendingPathComponent:kVoipTokenFileName]
             atomically:YES
               encoding:NSUTF8StringEncoding
                  error:nil];
  CanariPushContext *ctx = CanariLoadPushContext();
  NSString *secret = CanariRetrievePushSecret();
  if (ctx == nil || secret == nil) {
    NSLog(@"[CanariCallKit] voip token persisted, registration deferred (no ctx/secret yet)");
    return;
  }
  NSURL *url = [NSURL
      URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/refresh-token", ctx.baseUrl]];
  if (url == nil) {
    return;
  }
  NSDictionary *payload =
      @{@"userId" : ctx.userId, @"deviceId" : ctx.deviceId, @"voipToken" : hexToken};
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
  req.HTTPMethod = @"POST";
  req.HTTPBody = body;
  [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  [req setValue:[NSString stringWithFormat:@"PushSecret %@", secret]
      forHTTPHeaderField:@"Authorization"];
  req.timeoutInterval = 5.0;
  [[[NSURLSession sharedSession] dataTaskWithRequest:req] resume];
  NSLog(@"[CanariCallKit] voip token registered on backend");
}

@interface CanariVoipPushDelegate : NSObject <PKPushRegistryDelegate>
@end

@implementation CanariVoipPushDelegate

- (void)pushRegistry:(PKPushRegistry *)registry
    didUpdatePushCredentials:(PKPushCredentials *)pushCredentials
                     forType:(PKPushType)type {
  (void)registry;
  (void)type;
  NSMutableString *hex = [NSMutableString stringWithCapacity:pushCredentials.token.length * 2];
  const unsigned char *bytes = (const unsigned char *)pushCredentials.token.bytes;
  for (NSUInteger i = 0; i < pushCredentials.token.length; i++) {
    [hex appendFormat:@"%02x", bytes[i]];
  }
  NSLog(@"[CanariCallKit] voip credentials updated (%lu bytes)",
        (unsigned long)pushCredentials.token.length);
  CanariPersistVoipToken(hex);
}

- (void)pushRegistry:(PKPushRegistry *)registry
    didInvalidatePushTokenForType:(PKPushType)type {
  (void)registry;
  (void)type;
  NSString *dir = CanariTauriDataDir();
  if (dir != nil) {
    [[NSFileManager defaultManager]
        removeItemAtPath:[dir stringByAppendingPathComponent:kVoipTokenFileName]
                   error:nil];
  }
  NSLog(@"[CanariCallKit] voip token invalidated");
}

/// Apple contract: EVERY VoIP push must report an incoming call before `completion` runs, or the
/// app is terminated (and eventually banned from VoIP pushes). So this handler reports on EVERY
/// path, synchronously (the registry's queue is the main queue): a ring for a live call rings, and a
/// stale or malformed push is reported and ended in the same breath.
///
/// The payload names nobody (`voipRingPayload` server-side, decision 6): the caller's name comes
/// from this phone's own copy (`CanariCallerDisplayName`).
- (void)pushRegistry:(PKPushRegistry *)registry
    didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
                              forType:(PKPushType)type
                withCompletionHandler:(void (^)(void))completion {
  (void)registry;
  (void)type;
  NSDictionary *data = payload.dictionaryPayload;
  NSString *msgType = [data[@"type"] isKindOfClass:[NSString class]] ? data[@"type"] : @"";
  NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
  NSString *callId = [data[@"callId"] isKindOfClass:[NSString class]] ? data[@"callId"] : @"";
  NSString *callerId = [data[@"callerId"] isKindOfClass:[NSString class]] ? data[@"callerId"] : @"";
  long long ringUntilMs = [data[@"ringUntil"] isKindOfClass:[NSString class]]
                              ? [(NSString *)data[@"ringUntil"] longLongValue]
                              : 0;
  NSLog(@"[CanariCallKit] voip push type=%@ call=%@", msgType, callId);

  if (CanariPushSignedOut()) {
    // A SIGNED-OUT DEVICE RINGS FOR NOBODY. PushKit still requires every VoIP push to be reported
    // to CallKit, so a placeholder with no caller and no conversation is reported and ended at once
    // (deadline 0) - nothing of the account that signed out is shown.
    NSLog(@"[CanariCallKit] voip push type=%@ while signed out - reported and ended", msgType);
    CanariReportVoipCall(@"", [[NSUUID UUID] UUIDString], @"", 0);
  } else if ([msgType isEqualToString:@"call_ring"] && callId.length > 0) {
    CanariReportVoipCall(groupId, callId, callerId, ringUntilMs);
  } else {
    // Contract keeper: an unexpected payload still reports a call, ended at once (deadline 0).
    NSLog(@"[CanariCallKit] ERROR unexpected voip payload type=%@ - reported and ended", msgType);
    NSString *bogusId = callId.length > 0 ? callId : [[NSUUID UUID] UUIDString];
    CanariReportVoipCall(groupId, bogusId, @"", 0);
  }
  completion();
}

@end

static CanariVoipPushDelegate *g_voipPushDelegate = nil;

/// The page STARTED ringing `callIdC` itself (Rust `page_ring`, through the listener
/// `CanariCallKitSetup` registers). With the app ACTIVE, an unanswered CallKit ring of that call is
/// the second ring of one call - CallKit rang it while the page had no socket, then the unlock came
/// in time for the invite - and no activation follows to run the handover, so it is ended here, as
/// the handover would (`AnsweredElsewhere`: the page took it over). Tells nothing more: an answered
/// call is the handover's, and an inactive app is judged at its activation.
///
/// Called on the thread of the Tauri command, with an id valid for the call only: the id is copied
/// here, and the judgement made on the main queue, where every CallKit fact lives.
static void CanariPageStartedRinging(const char *callIdC) {
  if (callIdC == NULL) {
    NSLog(@"[CanariCallKit] ERROR the page started ringing a call with no id - nothing judged");
    return;
  }
  NSString *callId = [NSString stringWithUTF8String:callIdC];
  if (callId.length == 0) {
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    NSUUID *uuid = g_ringingCalls[callId];
    if (uuid == nil) {
      return;  // CallKit does not ring it: the page's is the only ring
    }
    if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) {
      NSLog(@"[CanariCallKit] call=%@ rings in the page and in CallKit, app not active - judged at "
            @"its activation",
            callId);
      return;
    }
    if ([g_ringingCallInfo[uuid.UUIDString][@"answered"] boolValue]) {
      return;  // answered on CallKit: the handover owns it
    }
    NSLog(@"[CanariCallKit] call=%@ now rings in the active page - its unanswered CallKit ring is "
          @"ended",
          callId);
    CanariEndCallKitCall(callId, CXCallEndedReasonAnsweredElsewhere);
  });
}

/// Installs PushKit (VoIP credentials + pushes) and the app-active handover: once the app is
/// active the in-app call UI owns the experience, so any lingering CallKit session is closed.
static void CanariCallKitSetup(void) {
  CanariEnsureCallProvider();
  g_voipPushDelegate = [[CanariVoipPushDelegate alloc] init];
  g_voipRegistry = [[PKPushRegistry alloc] initWithQueue:dispatch_get_main_queue()];
  g_voipRegistry.delegate = g_voipPushDelegate;
  g_voipRegistry.desiredPushTypes = [NSSet setWithObject:PKPushTypeVoIP];

  [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                CanariHandOverCallsToPage(@"the app became active");
              }];
  // An app ALREADY active sees no activation: the page's own start of a ring is the other trigger.
  canari_ios_set_page_ringing_listener(CanariPageStartedRinging);
  NSLog(@"[CanariCallKit] PushKit registry + CallKit provider installed");
}

static void CanariHandleMlsMessage(NSDictionary *data) {
  NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
  NSString *groupName = [data[@"groupName"] isKindOfClass:[NSString class]] ? data[@"groupName"] : @"";
  NSString *senderName = [data[@"senderName"] isKindOfClass:[NSString class]] ? data[@"senderName"] : @"";
  NSString *senderId = [data[@"senderId"] isKindOfClass:[NSString class]] ? data[@"senderId"] : @"";
  NSString *queuedMessageId =
      [data[@"queuedMessageId"] isKindOfClass:[NSString class]] ? data[@"queuedMessageId"] : nil;
  NSString *inlineProto = [data[@"proto"] isKindOfClass:[NSString class]] ? data[@"proto"] : @"";
  // nil when the push did not say - see `CanariWriteFcmCache`. Swift twin: `NotificationService`.
  NSNumber *isGroup = [data[@"isGroup"] isKindOfClass:[NSString class]]
                          ? @([data[@"isGroup"] isEqualToString:@"true"])
                          : nil;
  // NO SILENT FRAME REACHES HERE: every one is sent `content-available` and handled by
  // `CanariHandleBackgroundFrame`, which never decrypts - an MLS load and the state lock to read a
  // frame whose only use is a dismissal was the cost the durable rule on silent frames forbids.

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    CanariDecryptedMessage *decrypted = CanariTryDecrypt(queuedMessageId, groupId, senderId, inlineProto);
    int raceAttempt = 0;
    while (decrypted == nil && queuedMessageId.length > 0 && raceAttempt < kWelcomeRaceRetries) {
      raceAttempt++;
      usleep(kWelcomeRaceRetryDelayUs);
      decrypted = CanariTryDecrypt(queuedMessageId, groupId, senderId, inlineProto);
    }

    // Epoch gap: the direct decrypt failed. A frequent cause on a never-opened device is that a
    // device added to the group advanced the epoch (commit) that this device never applied in the
    // background (push decrypt is read-only). Attempt an in-memory commit catch-up (read-only,
    // mls.bin unchanged) to produce a real notification instead of the generic fallback.
    if (decrypted == nil && queuedMessageId.length > 0) {
      decrypted = CanariTryDecryptWithCommitCatchup(queuedMessageId, groupId, senderId, inlineProto);
    }

    // Call signaling over MLS (WP-XP-5, app running in background): never a message notification,
    // and NEVER A RING. The one native ring is the server's `call_ring` (VoIP or FCM), because only
    // the server applies calls_mode, the per-conversation permission, the video rule and blocks; a
    // decrypted invite rang past all four. Control: hangup/answered also ends an active CallKit ring.
    if (decrypted != nil && [decrypted.type isEqualToString:@"call_invite"]) {
      NSLog(@"[CanariPush] call_invite over MLS: not a ring - the server's call_ring is the only one");
      return;
    }
    if (decrypted != nil && [decrypted.type isEqualToString:@"call_control"]) {
      if (decrypted.callEnded && decrypted.callId.length > 0) {
        CanariEndCallKitCall(decrypted.callId, CXCallEndedReasonRemoteEnded);
      }
      NSLog(@"[CanariPush] call_control removed (ended=%d)", decrypted.callEnded);
      return;
    }

    NSString *body = decrypted.text;
    if (body.length == 0) {
      if (queuedMessageId.length > 0) {
        CanariRunBackgroundCleanup();
        NSLog(@"[CanariPush] decrypt failed - cleanup pending db");
      }
      body = CanariBuildFallbackText(senderName);
    } else {
      CanariWriteFcmCache(groupId, senderId, senderName, groupName, isGroup, decrypted);
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      // MLS: the server cannot know who is mentioned, so the body scan inside decides.
      CanariShowMessageNotification(senderName, groupName, body, groupId, senderId, decrypted, NO,
                                    senderName, NO, YES);
    });

    CanariPushContext *drainCtx = CanariLoadPushContext();
    if (drainCtx != nil) {
      int remaining = CanariDrainOutboxBackground(drainCtx);
      CanariMaybeNotifyPendingSync(remaining);
    }
  });
}

// --- Channel (community) message push --------------------------------------

// Generic body shown when a channel message cannot be decrypted (key missing or ciphertext omitted).
static NSString *CanariBuildChannelFallbackText(NSString *channelName) {
  return [NSString stringWithFormat:CanariLocalized(@"notif.channel.message"), channelName];
}

// Whether graine_seeds.json (written by the foreground, sealed under the install's native cache
// key) holds a Graine session - asked of Rust, which alone opens the file, so the seed never
// enters Objective-C.
//
// The mirror is BOUNDED to the newest sessions per channel, so a miss on an old session is
// expected and not a fault: the banner degrades to the generic body, the same outcome an
// oversized ciphertext already produces. An unreadable mirror reads as a miss, and says so.
static BOOL CanariGraineSeedHeld(NSString *channelId, NSString *sessionId) {
  if (sessionId.length == 0) {
    return NO;
  }
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return NO;
  }
  int32_t held = canari_native_graine_seed_held(dir.UTF8String,
                                                CanariRetrieveNativeCacheKey().UTF8String,
                                                channelId.UTF8String, sessionId.UTF8String);
  if (held < 0) {
    NSLog(@"[CanariPush] graineSeedHeld: ERROR the seed mirror is unreadable channel=%@", channelId);
  }
  return held == 1;
}

// Decrypts a community-channel push sealed under a Graine session (AES-256-GCM, not MLS) and shows
// a notification. The seed is read from graine_seeds.json and the message key derived from it in
// Rust; the inline ciphertext is decrypted natively so the plaintext never transits FCM. Falls back
// to a generic body when the seed is missing (session older than the bounded mirror, or a salon not
// yet hydrated) or the ciphertext was omitted server-side. Mirror of Android handleChannelMessage.
static void CanariHandleChannelMessage(NSDictionary *data) {
  NSString *channelId =
      [data[@"channelId"] isKindOfClass:[NSString class]] ? data[@"channelId"] : @"";
  // The default when the server could not name the salon is a WORD, so it comes from the table like
  // every other sentence here. Android twin: R.string.notif_channel_unnamed.
  NSString *channelName = ([data[@"channelName"] isKindOfClass:[NSString class]] &&
                           [(NSString *)data[@"channelName"] length] > 0)
                              ? data[@"channelName"]
                              : CanariLocalized(@"notif.channel.unnamed");
  NSString *workspaceName = ([data[@"workspaceName"] isKindOfClass:[NSString class]] &&
                             [(NSString *)data[@"workspaceName"] length] > 0)
                                ? data[@"workspaceName"]
                                : @"";
  NSString *sessionId =
      [data[@"senderSessionId"] isKindOfClass:[NSString class]] ? data[@"senderSessionId"] : @"";
  // An index of 0 is the first message of every session, so "absent" is carried by the STRING
  // being empty and never by the number being zero.
  NSString *messageIndexStr =
      [data[@"messageIndex"] isKindOfClass:[NSString class]] ? data[@"messageIndex"] : @"";
  NSString *ciphertext =
      [data[@"ciphertext"] isKindOfClass:[NSString class]] ? data[@"ciphertext"] : @"";
  NSString *nonce = [data[@"nonce"] isKindOfClass:[NSString class]] ? data[@"nonce"] : @"";
  NSString *senderId = [data[@"senderId"] isKindOfClass:[NSString class]] ? data[@"senderId"] : @"";
  // Stated by the server (per recipient, from the sender's cleartext mentionedUserIds) rather than
  // scanned out of the body - the only answer that survives a ciphertext too large to inline.
  BOOL mentionsMe = [data[@"mentioned"] isKindOfClass:[NSString class]] &&
                    [(NSString *)data[@"mentioned"] isEqualToString:@"true"];
  if (channelId.length == 0) {
    NSLog(@"[CanariPush] handleChannelMessage: channelId missing - abort");
    return;
  }
  // The app addresses channels as `channel_<uuid>`; use it for the deep link + stable notif id.
  NSString *conversationId = [NSString stringWithFormat:@"channel_%@", channelId];

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString *body = nil;
    BOOL seedHeld = (ciphertext.length > 0 && nonce.length > 0 && messageIndexStr.length > 0) &&
                    CanariGraineSeedHeld(channelId, sessionId);
    if (seedHeld) {
      // Rust reads the session from the mirror itself and applies the floor and, under a v2
      // session, the author, the signature and the AAD (channel-encryption section 21.5).
      // `seedHeld` above only says whether the mirror holds it.
      NSString *signature =
          [data[@"signature"] isKindOfClass:[NSString class]] ? data[@"signature"] : @"";
      NSString *dir = CanariTauriDataDir();
      // The app language Rust words its own sentences in; "" when none was mirrored.
      NSString *locale = CanariLoadPushContext().locale ?: @"";
      char *jsonPtr =
          dir == nil ? nil
                     : canari_native_open_graine_push(
                           dir.UTF8String, CanariRetrieveNativeCacheKey().UTF8String,
                           channelId.UTF8String, sessionId.UTF8String,
                           (uint32_t)[messageIndexStr intValue], senderId.UTF8String,
                           nonce.UTF8String, ciphertext.UTF8String, signature.UTF8String,
                           locale.UTF8String);
      if (jsonPtr != nil) {
        NSString *jsonStr = [NSString stringWithUTF8String:jsonPtr];
        canari_free_string(jsonPtr);
        NSData *jsonData = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
        id json = jsonData != nil
                      ? [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil]
                      : nil;
        if ([json isKindOfClass:[NSDictionary class]] &&
            [((NSDictionary *)json)[@"ok"] boolValue]) {
          NSString *text = [((NSDictionary *)json)[@"text"] isKindOfClass:[NSString class]]
                               ? ((NSDictionary *)json)[@"text"]
                               : @"";
          if (text.length > 200) {
            text = [text substringToIndex:200];
          }
          body = text.length > 0 ? text : nil;
        } else {
          id reason = [json isKindOfClass:[NSDictionary class]] ? ((NSDictionary *)json)[@"reason"]
                                                                  : nil;
          NSLog(@"[CanariPush] handleChannelMessage: decrypt ok=false reason=%@ channel=%@",
                [reason isKindOfClass:[NSString class]] ? reason : @"none", channelId);
        }
      }
    } else {
      NSLog(@"[CanariPush] handleChannelMessage: no key/ciphertext - generic notification "
            @"channel=%@",
            channelId);
    }
    // THE AUTHOR AND THE MENTION ARE THE SERVER'S WORDS until the open proves them, so a blind
    // banner draws neither: no face, no mention route. Android twin: `ChannelBannerAttribution`.
    BOOL showsMessage = body.length > 0;
    NSString *shownSenderId = showsMessage ? senderId : @"";
    BOOL shownMentionsMe = showsMessage && mentionsMe;
    if (!showsMessage) {
      body = CanariBuildChannelFallbackText(channelName);
      if (senderId.length > 0 || mentionsMe) {
        NSLog(@"[CanariPush] handleChannelMessage: blind banner -> no author, no mention "
              @"(server named sender=%@ mentioned=%d) channel=%@",
              senderId.length > 8 ? [senderId substringToIndex:8] : senderId, mentionsMe, channelId);
      }
    }

    // `<Communaute> - #<salon>`: a salon name alone is ambiguous, two communities may both have a
    // `#general`. Degrades to the salon alone when the server could not name the workspace. The
    // same format is spelled by the social-service alert title, the Kotlin service and the iOS
    // extension; `channelPushFields.test.ts` holds the four together.
    NSString *displayName = workspaceName.length > 0
                                ? [NSString stringWithFormat:@"%@ - #%@", workspaceName, channelName]
                                : [NSString stringWithFormat:@"#%@", channelName];
    dispatch_async(dispatch_get_main_queue(), ^{
      // groupName empty + senderName as the title -> the banner shows it as-is; avatar from senderId
      // when the open proved it. No media thumbnail for channels (WP-XP-3 is MLS DM/group only) ->
      // pass nil. The initials fall back to the SALON, not to the composed title: Android twin uses
      // channelName for exactly the same reason.
      CanariShowMessageNotification(displayName, @"", body, conversationId, shownSenderId, nil,
                                    shownMentionsMe, channelName, YES, NO);
    });
  });
}

/**
 * Handles an ALERT frame's data while the app process runs: `willPresentNotification` (foreground)
 * and a tap. A silent frame never comes here - `CanariHandleBackgroundFrame` owns those - so the
 * `isWelcome` and `process_queue` branches below, which only a silent frame carries, are reached by
 * nothing on iOS today (docs/wiki/backlog.md). The `welcome_request_pending` branch was the same and
 * was deleted on 2026-10-22: it merged its add into `mls.bin` before the server answered, which
 * Android stopped doing that day; a background re-add on iOS waits for the background-join row fix.
 */
static void CanariHandleFcmData(NSDictionary *data) {
  if (data.count == 0) {
    return;
  }
  NSString *msgType = [data[@"type"] isKindOfClass:[NSString class]] ? data[@"type"] : @"";

  NSLog(@"[CanariPush] onMessage type=%@ action=%@ groupId=%@", msgType, data[@"action"],
        data[@"groupId"]);

  // A SIGNED-OUT DEVICE ACTS ON NOTHING. No account owns this install's pushes until the next
  // registration is answered (`push_registration.rs`); a push still reaching it was sent before the
  // server ended the session's registration, and acting on it would act as the account that left.
  if (CanariPushSignedOut()) {
    NSLog(@"[CanariPush] dropped type=%@ - this device is signed out, no account owns its pushes",
          msgType);
    return;
  }

  // `call_ring_end` is a background frame (calls.service), so `CanariHandleBackgroundFrame` owns it.
  // `call_ring` normally arrives as an APNs VoIP push (PushKit path); a legacy-registered device
  // (no voipToken yet) receives it via FCM instead. A page in front holding the socket rings
  // in-app -> skip; at the PIN gate it holds none, and CallKit is the only ring.
  if ([msgType isEqualToString:@"call_ring"]) {
    if (CanariForegroundPageRings()) {
      NSLog(@"[CanariPush] call_ring with the page holding the socket - the in-app overlay rings");
      return;
    }
    NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
    NSString *callId = [data[@"callId"] isKindOfClass:[NSString class]] ? data[@"callId"] : @"";
    // Ids only, as the VoIP push (decision 6): the name is this phone's to give.
    NSString *callerId = [data[@"callerId"] isKindOfClass:[NSString class]] ? data[@"callerId"] : @"";
    if (callId.length > 0) {
      CanariReportIncomingCall(groupId, callId, callerId,
                               [data[@"hasVideo"] isEqualToString:@"true"]);
    }
    return;
  }

  // A REACTION RIDES ON `social` WITHOUT BEING ONE - see the Android service and notify-reaction in
  // chat-delivery-service. The wire type stays `social` so clients predating this change render it
  // instead of dropping it into the MLS ladder; the discriminator is a separate field.
  BOOL isReaction = [msgType isEqualToString:@"social"] &&
                    [data[@"reaction"] isKindOfClass:[NSString class]] &&
                    [(NSString *)data[@"reaction"] isEqualToString:@"true"];

  // The `social` exemption below does not extend to a reaction: it is drawn INTO the conversation's
  // own notification, and posting one over a conversation being read is noise - the bubble on screen
  // already carries it, delivered by the WebSocket.
  BOOL showsWhileForeground =
      [msgType isEqualToString:@"form_reminder"] || ([msgType isEqualToString:@"social"] && !isReaction);
  if (canari_ios_is_in_foreground() && !showsWhileForeground) {
    NSLog(@"[CanariPush] foreground actif - skip background MLS");
    return;
  }

  if ([data[@"isWelcome"] isEqualToString:@"true"]) {
    NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
    NSString *queuedMessageId =
        [data[@"queuedMessageId"] isKindOfClass:[NSString class]] ? data[@"queuedMessageId"] : nil;
    NSString *inlineProto = [data[@"proto"] isKindOfClass:[NSString class]] ? data[@"proto"] : @"";
    if (groupId.length == 0) {
      NSLog(@"[CanariPush] isWelcome: groupId missing");
      return;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CanariProcessReceivedWelcomeBackground(groupId, queuedMessageId, inlineProto);
    });
    return;
  }

  // A reaction to one of MY messages. The push carries an id, an emoji and who reacted - never the
  // message, which this device holds already, being its author's. It used to carry 80 characters of
  // the decrypted text, put there by the reacting client and turned into a sentence by the server,
  // so conversation plaintext crossed our server, Google and Apple on every reaction.
  //
  // It leaves through the notification primitive rather than the `social` one, with `groupId` passed
  // as nil ON PURPOSE: that argument is what attaches the reply / mark-as-read category, and neither
  // means anything against a reaction. The stable id and the conversation thread are passed
  // separately, so the reaction still lands IN the conversation's notification and still replaces
  // itself instead of stacking a new one for ever - which is the defect being fixed.
  if (isReaction) {
    NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
    if (groupId.length == 0) {
      NSLog(@"[CanariPush] reaction without groupId - dropped, nothing to attach it to");
      return;
    }
    NSString *actorName = [data[@"title"] isKindOfClass:[NSString class]] ? data[@"title"] : @"Canari";
    NSString *emoji = [data[@"emoji"] isKindOfClass:[NSString class]] ? data[@"emoji"] : @"";
    NSString *actorId = [data[@"senderId"] isKindOfClass:[NSString class]] ? data[@"senderId"] : @"";

    NSString *attachmentPath = nil;
    CanariPushContext *ctx = CanariLoadPushContext();
    if (ctx != nil && actorId.length > 0) {
      attachmentPath = CanariFetchAvatar(ctx, actorId);
    }
    if (attachmentPath == nil) {
      attachmentPath = CanariInitialsImagePath(actorName);
    }

    NSString *deepLink = CanariChatLink(groupId, @"") ?: @"fr.emse.canari://chat";
    NSLog(@"[CanariPush] reaction group=%@ actor=%@", groupId, actorId);
    CanariShowLocalNotification(actorName, CanariReactionBody(emoji), deepLink, groupId,
                                CanariStableNotifId(groupId), attachmentPath, nil, NO, nil, 0,
                                kCanariSoundReaction);
    return;
  }

  if ([msgType isEqualToString:@"social"] || [msgType isEqualToString:@"form_reminder"]) {
    NSString *title = [data[@"title"] isKindOfClass:[NSString class]] ? data[@"title"] : @"Canari";
    NSString *body = [data[@"body"] isKindOfClass:[NSString class]] ? data[@"body"] : @"";
    // Since 2026-08-19 the sentence is written HERE, in the language chosen inside Canari; the
    // server's own title/body above survive only for a server predating that change.
    CanariComposeServerNotification(data, &title, &body);
    NSString *postId = [data[@"postId"] isKindOfClass:[NSString class]] ? data[@"postId"] : @"";
    NSString *formId = [data[@"formId"] isKindOfClass:[NSString class]] ? data[@"formId"] : @"";
    NSString *deepLink = @"fr.emse.canari://posts";
    if ([data[@"deepLink"] isKindOfClass:[NSString class]] && [(NSString *)data[@"deepLink"] length] > 0) {
      deepLink = data[@"deepLink"];
    } else if (postId.length > 0) {
      deepLink = [NSString stringWithFormat:@"fr.emse.canari://post/%@", postId];
    } else if (formId.length > 0) {
      deepLink = [NSString stringWithFormat:@"fr.emse.canari://form/%@", formId];
    }
    NSString *thread = [msgType isEqualToString:@"form_reminder"] ? @"canari_forms" : @"canari_social";
    CanariShowLocalNotification(title, body, deepLink, thread, 0, nil, nil, NO, nil, 0, nil);
    return;
  }

  // Community (channel) encrypted message: AES-256-GCM under a Graine session, seed looked up in
  // graine_seeds.json. Not MLS: no mls.bin, no state lock - decryption is stateless and read-only.
  if ([msgType isEqualToString:@"channel"]) {
    NSLog(@"[CanariPush] type=channel channelId=%@ - notification channel background",
          data[@"channelId"]);
    CanariHandleChannelMessage(data);
    return;
  }

  // `channel_read` is a background frame: `CanariHandleBackgroundFrame` clears it.

  if ([data[@"action"] isEqualToString:@"process_queue"]) {
    NSLog(@"[CanariPush] action=process_queue - cleanup pending db");
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      CanariRunBackgroundCleanup();
    });
    if (data[@"groupId"] == nil) {
      return;
    }
  }

  CanariHandleMlsMessage(data);
}

void CanariPushCancelMessageNotifications(void) {
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center getDeliveredNotificationsWithCompletionHandler:^(
              NSArray<UNNotification *> *_Nonnull notifications) {
    NSMutableArray<NSString *> *ids = [NSMutableArray array];
    for (UNNotification *n in notifications) {
      NSString *thread = n.request.content.threadIdentifier;
      NSString *deepLink = n.request.content.userInfo[@"deepLink"];
      // WP-XP-7: per-conversation notifications use the groupId as threadIdentifier, not the
      // old flat "canari_messages" thread. Also catch legacy notifications that have no thread
      // (empty) or the old flat thread. The deepLink prefix check is a safety net.
      BOOL isChatNotif = [thread isEqualToString:@"canari_messages"] || thread.length == 0 ||
                         [deepLink hasPrefix:@"fr.emse.canari://chat"];
      if (isChatNotif) {
        [ids addObject:n.request.identifier];
      }
    }
    if (ids.count > 0) {
      [center removeDeliveredNotificationsWithIdentifiers:ids];
    }
    // Clearing every message notification (app opened) drops the badge to 0 (WP-XP-2). Counted
    // from what remains in the array already read, not by re-reading after an uncompleted removal.
    CanariSetBadgeCount(CanariCountUnreadConversations(notifications, [NSSet setWithArray:ids]));
  }];
}

/** Strips APNs `aps` and Firebase metadata keys; keeps flat string data fields. */
static NSDictionary *_Nullable CanariFcmDataFromUserInfo(NSDictionary *userInfo) {
  if (userInfo.count == 0) {
    return nil;
  }
  NSMutableDictionary *data = [NSMutableDictionary dictionary];
  [userInfo enumerateKeysAndObjectsUsingBlock:^(id key, id obj, __unused BOOL *stop) {
    if (![key isKindOfClass:[NSString class]]) {
      return;
    }
    NSString *k = (NSString *)key;
    if ([k isEqualToString:@"aps"]) {
      return;
    }
    if ([k hasPrefix:@"gcm."] || [k hasPrefix:@"google."]) {
      return;
    }
    if ([obj isKindOfClass:[NSString class]]) {
      data[k] = obj;
    } else if ([obj isKindOfClass:[NSNumber class]]) {
      data[k] = [(NSNumber *)obj stringValue];
    }
  }];
  return data.count > 0 ? data : nil;
}

/**
 * Firebase 12+ no longer delivers data via `messaging:didReceiveMessage:`.
 * All FCM/APNs payloads arrive as `userInfo` on the app or notification delegate.
 */
static void CanariPushProcessRemoteNotificationUserInfo(NSDictionary *userInfo) {
  NSDictionary *data = CanariFcmDataFromUserInfo(userInfo);
  if (data == nil) {
    return;
  }
#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
  [[FIRMessaging messaging] appDidReceiveMessage:userInfo];
#endif
  CanariHandleFcmData(data);
}

// --- Silent (`content-available`) frames, handed to us by hand ---------------------------------
//
// WHY THIS IS ADDED RATHER THAN SWIZZLED. A silent frame reaches an app only through
// `application:didReceiveRemoteNotification:fetchCompletionHandler:`. wry's delegate does not
// implement it and Firebase's proxy, which would have, found no delegate at configure time (the APNs
// token hook below has the measurement). The old hook only REPLACED an existing method, so it was
// never installed: `remote notification hook NOT installed` on every launch of the iPhone 12 bench
// (2026-10-14/15), and no `channel_read` dismissal ever ran on iOS. `class_replaceMethod` ADDS the
// method when absent and chains to it when a later wry starts implementing it - the token hook's
// technique, for the same reason.
//
// WHAT IT CHANGES: Canari code now RUNS on every silent frame iOS hands the process, foreground,
// backgrounded, or launched in the background for it (the `remote-notification` background mode was
// already declared, so whether iOS wakes the process is not what this decides - what runs is).
// So what such a frame may DO is an allowlist (`CanariHandleBackgroundFrame`), never "whatever
// `CanariHandleFcmData` does": that function also joins groups and answers Welcome requests, MLS
// writes no iPhone has ever run in the background, and the Android twin of that join is the
// conversation-row defect still open in docs/wiki/backlog.md.

typedef void (^CanariRemoteNotifCompletion)(UIBackgroundFetchResult);
static void (*CanariOrigDidReceiveRemoteNotification)(id, SEL, UIApplication *, NSDictionary *,
                                                      CanariRemoteNotifCompletion) = NULL;

/**
 * Whether an APNs payload is a SILENT frame: `content-available` and nothing to draw.
 *
 * Decided on the payload's own `aps`, which the server builds per kind (`buildApnsRequest`,
 * `buildInternalApnsRequest`): a silent frame is `{content-available: 1}` and nothing else, an alert
 * is `{mutable-content: 1, alert: ...}` and never `content-available`. An alert belongs to the
 * extension (killed or background) and `willPresentNotification` (foreground), so handling one here
 * too would draw it twice.
 */
static BOOL CanariIsSilentFrame(NSDictionary *userInfo) {
  NSDictionary *aps = [userInfo[@"aps"] isKindOfClass:[NSDictionary class]] ? userInfo[@"aps"] : nil;
  id available = aps[@"content-available"];
  BOOL wakes = [available respondsToSelector:@selector(intValue)] && [available intValue] == 1;
  return wakes && aps[@"alert"] == nil;
}

/**
 * WHAT A SILENT FRAME MAY DO WHEN IT WAKES THIS PROCESS - AN ALLOWLIST OF KINDS, each a dismissal.
 *
 * - `channel_read`: a salon was read on another of my devices - clear its notification here.
 * - an MLS `message` frame (never a Welcome) whose sender is ME: my own read receipt or own-device
 *   copy from another device - clear that conversation's notification. Decided on the cleartext
 *   `senderId`, so no frame is decrypted to learn it carries nothing.
 * - `call_ring_end`: end the CallKit ring of that call (a no-op when none rings for it).
 *
 * Every other kind is NOT acted on and says so: a Welcome, a `welcome_request_pending`, a peer's
 * read receipt, a commit. The two Welcome kinds would be the first background MLS write on iOS and
 * wait for the background-join row fix ("A group joined in the background has no conversation row",
 * docs/wiki/backlog.md); the rest carry nothing to show.
 *
 * `done` is called exactly once, after the work it waits for has been issued.
 */
static void CanariHandleBackgroundFrame(NSDictionary *data, void (^done)(UIBackgroundFetchResult)) {
  NSString *msgType = [data[@"type"] isKindOfClass:[NSString class]] ? data[@"type"] : @"";
  NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
  NSLog(@"[CanariPush] onMessage background frame type=%@ groupId=%@", msgType, groupId);

  if ([msgType isEqualToString:@"channel_read"]) {
    NSString *channelId =
        [data[@"channelId"] isKindOfClass:[NSString class]] ? data[@"channelId"] : @"";
    if (channelId.length == 0) {
      NSLog(@"[CanariPush] channel_read without channelId - nothing to clear");
      done(UIBackgroundFetchResultNoData);
      return;
    }
    NSString *conversationId = [NSString stringWithFormat:@"channel_%@", channelId];
    NSLog(@"[CanariPush] type=channel_read - clearing notification channel=%@", channelId);
    dispatch_async(dispatch_get_main_queue(), ^{
      CanariCancelConversationNotification(conversationId, ^{
        done(UIBackgroundFetchResultNewData);
      });
    });
    return;
  }

  if ([msgType isEqualToString:@"call_ring_end"]) {
    NSString *callId = [data[@"callId"] isKindOfClass:[NSString class]] ? data[@"callId"] : @"";
    NSString *reason = [data[@"reason"] isKindOfClass:[NSString class]] ? data[@"reason"] : @"";
    CanariEndCallKitCall(callId, [reason isEqualToString:@"answered"]
                                     ? CXCallEndedReasonAnsweredElsewhere
                                     : CXCallEndedReasonRemoteEnded);
    // The generic ring ALERT an iPhone with no VoIP token gets (the NSE tags it with
    // `canariCallId`) is taken off the lock screen too, so a call already over is not left ringing
    // there. Best effort: a background push can be dropped. The alert's `apns-expiration` only bounds APNs
    // store-and-forward; a DELIVERED banner stays until removed - here, or on app activation, where
    // `CanariPushCancelMessageNotifications` clears it (its `deepLink` is a chat link).
    if (callId.length > 0) {
      UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
      [center getDeliveredNotificationsWithCompletionHandler:^(
                  NSArray<UNNotification *> *_Nonnull notifications) {
        NSMutableArray<NSString *> *ids = [NSMutableArray array];
        for (UNNotification *n in notifications) {
          if ([n.request.content.userInfo[@"canariCallId"] isEqual:callId]) {
            [ids addObject:n.request.identifier];
          }
        }
        if (ids.count > 0) {
          NSLog(@"[CanariPush] call_ring_end - removing %lu delivered ring alert(s)",
                (unsigned long)ids.count);
          [center removeDeliveredNotificationsWithIdentifiers:ids];
        }
        done(UIBackgroundFetchResultNoData);
      }];
      return;
    }
    done(UIBackgroundFetchResultNoData);
    return;
  }

  BOOL isWelcome = [data[@"isWelcome"] isEqualToString:@"true"];
  if ([msgType isEqualToString:@"message"] && !isWelcome) {
    NSString *senderId = [data[@"senderId"] isKindOfClass:[NSString class]] ? data[@"senderId"] : @"";
    CanariPushContext *ctx = CanariLoadPushContext();
    if (ctx == nil) {
      NSLog(@"[CanariPush] silent message: push_context.json absent - cannot tell my own frame");
      done(UIBackgroundFetchResultNoData);
      return;
    }
    if (groupId.length > 0 && senderId.length > 0 &&
        [senderId caseInsensitiveCompare:ctx.userId] == NSOrderedSame) {
      dispatch_async(dispatch_get_main_queue(), ^{
        CanariCancelConversationNotification(groupId, ^{
          done(UIBackgroundFetchResultNewData);
        });
      });
      return;
    }
    NSLog(@"[CanariPush] silent message from a peer - nothing to dismiss");
    done(UIBackgroundFetchResultNoData);
    return;
  }

  NSLog(@"[CanariPush] background frame type=%@ isWelcome=%d NOT acted on - outside the "
        @"background allowlist (canari_push.mm, CanariHandleBackgroundFrame)",
        msgType, isWelcome);
  done(UIBackgroundFetchResultNoData);
}

/**
 * The delegate method iOS calls for a remote notification while the app runs or is woken for one.
 *
 * The completion handler is called ONCE, when both our work and any chained implementation are done:
 * calling it early lets iOS suspend the process with a removal still queued, and never calling it
 * makes iOS throttle every later wake.
 */
static void CanariSwizzledDidReceiveRemoteNotification(id self, SEL _cmd, UIApplication *application,
                                                       NSDictionary *userInfo,
                                                       CanariRemoteNotifCompletion completionHandler) {
  dispatch_group_t group = dispatch_group_create();
  // Written on the main queue only: every `done` below hops there before touching it.
  __block UIBackgroundFetchResult result = UIBackgroundFetchResultNoData;
  void (^merge)(UIBackgroundFetchResult) = ^(UIBackgroundFetchResult r) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (r == UIBackgroundFetchResultNewData ||
          (r == UIBackgroundFetchResultFailed && result == UIBackgroundFetchResultNoData)) {
        result = r;
      }
      dispatch_group_leave(group);
    });
  };

  dispatch_group_enter(group);
  NSDictionary *data = CanariFcmDataFromUserInfo(userInfo);
  if (!CanariIsSilentFrame(userInfo)) {
    // An alert: the extension drew it, or `willPresentNotification` handles it in the foreground.
    NSLog(@"[CanariPush] remote notification is an alert - left to the extension / willPresent");
    merge(UIBackgroundFetchResultNoData);
  } else if (data == nil) {
    NSLog(@"[CanariPush] silent frame with no data fields - nothing to do");
    merge(UIBackgroundFetchResultNoData);
  } else {
#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
    [[FIRMessaging messaging] appDidReceiveMessage:userInfo];
#endif
    CanariHandleBackgroundFrame(data, merge);
  }

  if (CanariOrigDidReceiveRemoteNotification != NULL) {
    dispatch_group_enter(group);
    CanariOrigDidReceiveRemoteNotification(self, _cmd, application, userInfo, merge);
  }
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    if (completionHandler != nil) {
      completionHandler(result);
    }
  });
}

/**
 * Adds (or chains) the silent-frame method on wry's delegate class. Call once launch has completed,
 * the first moment `sharedApplication.delegate` exists.
 *
 * Returns whether the delegate class was found, so the caller re-assigns the delegate only when a
 * method was actually added.
 */
static BOOL CanariInstallRemoteNotificationHook(void) {
  static dispatch_once_t once;
  static BOOL installed = NO;
  dispatch_once(&once, ^{
    id<UIApplicationDelegate> delegate = [UIApplication sharedApplication].delegate;
    if (delegate == nil) {
      NSLog(@"[CanariPush] remote notification hook: app delegate absent - silent frames reach no "
            @"native code");
      return;
    }
    Class delegateClass = [delegate class];
    CanariOrigDidReceiveRemoteNotification =
        (void (*)(id, SEL, UIApplication *, NSDictionary *, CanariRemoteNotifCompletion))
            class_replaceMethod(
                delegateClass,
                @selector(application:didReceiveRemoteNotification:fetchCompletionHandler:),
                (IMP)CanariSwizzledDidReceiveRemoteNotification, "v@:@@@?");
    installed = YES;
    NSLog(@"[CanariPush] remote notification hook installed on %@ (chained=%d)", delegateClass,
          CanariOrigDidReceiveRemoteNotification != NULL);
  });
  return installed;
}

/**
 * Sets the application's delegate to itself again, so UIKit re-reads which optional methods it
 * implements.
 *
 * UIKit records the delegate's optional-method answers when the delegate is SET; a method added
 * afterwards can go unseen. Firebase's own App Delegate Proxy does exactly this after it swizzles
 * (`GULAppDelegateSwizzler reassignAppDelegate`) - the proxy this file replaces by hand.
 *
 * THE DELEGATE IS THEN OWNED HERE, FOR THE LIFE OF THE PROCESS. `UIApplication.delegate` is
 * documented as not retaining. That the delegate `UIApplicationMain` created is kept by
 * UIApplication itself, and that a `setDelegate:` gives that ownership up, is BELIEVED, not read:
 * UIKit's source is closed, and Firebase keeping its own strong copy (`gOriginalAppDelegate`, set
 * on the line after its re-assignment) is the evidence. What WAS read (`pymobiledevice3 crash
 * pull`, iPhone 12, v1.3.0-alpha.2): `-[UIResponder _enumerateKeyboardShortcutsInChainWithOptions:
 * usingBlock:]` sent `_keyboardShortcutMenuLeaves` to a `_UISceneCloudKitShareMetadataBSActionHandler`
 * - a freed responder whose memory UIKit had reused - so the responder chain, whose last link
 * after UIApplication is this delegate, held a dead object. That the dead link IS the delegate is
 * the hypothesis this copy tests; the becoming-active log below says which object UIKit holds
 * (docs/wiki/backlog.md, P1 of 2026-10-19).
 */
static id<UIApplicationDelegate> g_appDelegateKeptAlive = nil;

static void CanariReassignAppDelegate(void) {
  UIApplication *app = [UIApplication sharedApplication];
  id<UIApplicationDelegate> delegate = app.delegate;
  if (delegate == nil) {
    NSLog(@"[CanariPush] app delegate absent - nothing to re-assign");
    return;
  }
  g_appDelegateKeptAlive = delegate;
  app.delegate = nil;
  app.delegate = delegate;
  NSLog(@"[CanariPush] app delegate re-assigned so UIKit reads the added methods (kept alive: %@)",
        [g_appDelegateKeptAlive class]);
}

/**
 * Logs, each time the app becomes active, which object UIKit holds as the application's delegate
 * compared with the one `CanariReassignAppDelegate` keeps alive.
 *
 * Diagnostic for the P1 of 2026-10-19: `same` on every activation, with no abort on an
 * accessibility read, is the reading that confirms the kept-alive fix; `nil` or `different` says the
 * re-assignment left UIKit pointing somewhere else. In that last case `class` names whatever lives
 * at the address UIKit holds: a UIKit-internal class there means a reused allocation, the very
 * signature the alpha.2 crash report carried.
 */
static void CanariLogAppDelegateIdentity(void) {
  id<UIApplicationDelegate> current = [UIApplication sharedApplication].delegate;
  if (current == nil) {
    NSLog(@"[CanariPush] became active: app delegate is nil (kept alive: %@)",
          g_appDelegateKeptAlive == nil ? @"none" : NSStringFromClass([g_appDelegateKeptAlive class]));
  } else if (current == g_appDelegateKeptAlive) {
    NSLog(@"[CanariPush] became active: app delegate is the kept-alive one (%@)",
          NSStringFromClass([current class]));
  } else {
    NSLog(@"[CanariPush] became active: app delegate %@ differs from the kept-alive one (%@)",
          NSStringFromClass([current class]),
          g_appDelegateKeptAlive == nil ? @"none" : NSStringFromClass([g_appDelegateKeptAlive class]));
  }
}

#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
/// Records WHY this device has no FCM token, next to the token it could not write.
///
/// The web layer reports the absence to the server, but on its own it can only say "no token" -
/// and that one word covers causes needing opposite fixes: APNs never answering at all, versus
/// APNs answering and FCM refusing. The device knows which; this is how it says so, instead of
/// leaving the reader to learn by failing what the client already knew. Pass nil to clear it: a
/// reason that outlives its cause is evidence for a question nobody asked.
static void CanariWritePushDiagnostic(NSString *_Nullable reason) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return;
  }
  NSString *path = [dir stringByAppendingPathComponent:@"push_diagnostic.txt"];
  if (reason == nil) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    return;
  }
  // No line of its own: every caller has just logged the cause in words, and repeating it as a
  // code doubled each one in the syslog (iPhone 12, 2026-10-15).
  [reason writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

/// Persist a freshly-obtained FCM token to fcm_token.txt and re-register it on the
/// backend when a push context + secret already exist. Shared by the delegate
/// callback (which fires only when the token CHANGES) and the launch-time fetch in
/// CanariPushSetup (which covers a token that rotated while the app was killed,
/// where the change callback never fires - the iOS peer of Android
/// MainActivity.onCreate's FirebaseMessaging.getInstance().token force-read).
static void CanariPersistFcmToken(NSString *fcmToken) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil || fcmToken.length == 0) {
    return;
  }
  NSString *path = [dir stringByAppendingPathComponent:@"fcm_token.txt"];
  [fcmToken writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
  CanariWritePushDiagnostic(nil);
  // The context first: a signed-out device has none, and its secret's absence is then the
  // sign-out, not the fault the secret lookup logs.
  CanariPushContext *ctx = CanariLoadPushContext();
  NSString *secret = ctx != nil ? CanariRetrievePushSecret() : nil;
  if (ctx != nil && secret != nil) {
    CanariRefreshTokenOnBackend(ctx, secret, fcmToken);
  }
}

@interface CanariFcmPushDelegate : NSObject <FIRMessagingDelegate>
@end

@implementation CanariFcmPushDelegate
- (void)messaging:(FIRMessaging *)messaging didReceiveRegistrationToken:(NSString *)fcmToken {
  (void)messaging;
  CanariPersistFcmToken(fcmToken);
}

@end

static CanariFcmPushDelegate *g_fcmPushDelegate = nil;

// --- The APNs token, handed to FIRMessaging by hand ------------------------------------------
//
// WHY THIS EXISTS. FIRMessaging cannot mint an FCM token before `FIRMessaging.APNSToken` is set,
// and the only thing that sets it is
// `application:didRegisterForRemoteNotificationsWithDeviceToken:`. Firebase normally intercepts
// that method itself through the App Delegate Proxy that Info.plist enables - but the proxy
// installs itself ONCE, reading `[UIApplication sharedApplication].delegate` at the moment
// Firebase is configured, and never looks again. Here `[FIRApp configure]` runs from
// `canari_ios_bootstrap()`, that is from `main()` BEFORE `ffi::start_app()`: there is no
// application object yet and therefore no delegate, so the proxy found nil, gave up, and its
// dispatch_once never fired a second time. wry's own delegate does not implement the method
// either. The APNs token the OS delivered on every launch had nowhere to land, `APNSToken` stayed
// nil for the platform's entire life, and every FCM fetch failed on its own precondition.
// Measured on hardware 2026-08-28: `push_token` held 49 android rows, never one ios row, and the
// device reported reason=no-token.
//
// The sibling hook above already had to swizzle wry's delegate for remote notifications, for
// exactly this reason; this is the same technique applied to the method carrying the token.
// `class_replaceMethod` covers both worlds without a second path: it ADDS the method when the
// delegate lacks it (the case today) and REPLACES it while handing back the previous
// implementation, which the replacement chains to - so a wry that starts implementing this is
// extended rather than silently overridden.

static void (*CanariOrigDidRegisterApns)(id, SEL, UIApplication *, NSData *) = NULL;
static void (*CanariOrigDidFailApns)(id, SEL, UIApplication *, NSError *) = NULL;

static void CanariSwizzledDidRegisterApns(id self, SEL _cmd, UIApplication *application,
                                          NSData *deviceToken) {
  [FIRMessaging messaging].APNSToken = deviceToken;
  NSLog(@"[CanariPush] APNs token received (%lu bytes) -> FIRMessaging",
        (unsigned long)deviceToken.length);
  // The precondition FIRMessaging waits on now holds, so ask here rather than leaving it to the
  // next foreground: this is the earliest instant at which the answer can be yes.
  CanariSyncFcmTokenIfApnsReady();
  if (CanariOrigDidRegisterApns != NULL) {
    CanariOrigDidRegisterApns(self, _cmd, application, deviceToken);
  }
}

static void CanariSwizzledDidFailApns(id self, SEL _cmd, UIApplication *application,
                                      NSError *error) {
  // The branch that was silent. APNs refusing registration - a missing aps-environment
  // entitlement, a provisioning profile without push, no network on a first launch - looked
  // exactly like a device nobody had ever opened.
  NSLog(@"[CanariPush] APNs registration REFUSED: %@", CanariErrorReason(error));
  CanariWritePushDiagnostic(@"apns-registration-refused");
  if (CanariOrigDidFailApns != NULL) {
    CanariOrigDidFailApns(self, _cmd, application, error);
  }
}

/// Installs both APNs-token callbacks on wry's delegate class. Call once launch has completed,
/// which is the first moment `sharedApplication.delegate` exists - the very thing Firebase's own
/// proxy could not wait for.
static void CanariInstallApnsTokenHook(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    id<UIApplicationDelegate> delegate = [UIApplication sharedApplication].delegate;
    if (delegate == nil) {
      NSLog(@"[CanariPush] APNs token hook: app delegate absent - no push token can be obtained");
      CanariWritePushDiagnostic(@"app-delegate-absent");
      return;
    }
    Class delegateClass = [delegate class];
    CanariOrigDidRegisterApns = (void (*)(id, SEL, UIApplication *, NSData *))class_replaceMethod(
        delegateClass, @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:),
        (IMP)CanariSwizzledDidRegisterApns, "v@:@@");
    CanariOrigDidFailApns = (void (*)(id, SEL, UIApplication *, NSError *))class_replaceMethod(
        delegateClass, @selector(application:didFailToRegisterForRemoteNotificationsWithError:),
        (IMP)CanariSwizzledDidFailApns, "v@:@@");
    NSLog(@"[CanariPush] APNs token hook installed on %@ (chained=%d)", delegateClass,
          CanariOrigDidRegisterApns != NULL);
  });
}
#endif

@interface CanariNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

/**
 * Whether a notification is the Share Extension's "choose the conversation" banner
 * (`canari_Share/ShareViewController.swift`). It is LOCAL and carries no push data and no deep link
 * by design: its tap only has to bring Canari forward, where the share is imported on activation.
 * Recognised first, so neither the push handling nor the "payload names no target" accusation sees it.
 */
static BOOL CanariIsShareNotification(NSDictionary *userInfo) {
  return [userInfo[@"canariLocal"] isKindOfClass:[NSString class]] &&
         [userInfo[@"canariLocal"] isEqualToString:@"incoming_share"];
}

@implementation CanariNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:
             (void (^)(UNNotificationPresentationOptions options))completionHandler {
  (void)center;
  if (CanariIsShareNotification(notification.request.content.userInfo)) {
    // The app is on screen: the share-ready signal has already imported the share and told the page.
    NSLog(@"[CanariShare] share banner while in the foreground - not shown, the page already has it");
    completionHandler(UNNotificationPresentationOptionNone);
    return;
  }
  CanariPushProcessRemoteNotificationUserInfo(notification.request.content.userInfo);
  if (canari_ios_is_in_foreground()) {
    completionHandler(UNNotificationPresentationOptionNone);
  } else {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
  }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
  (void)center;
  NSDictionary *userInfo = response.notification.request.content.userInfo;
  if (CanariIsShareNotification(userInfo)) {
    NSLog(@"[CanariShare] share banner tapped - the share is imported on activation");
    completionHandler();
    return;
  }
  CanariPushProcessRemoteNotificationUserInfo(userInfo);

  // Notification quick actions (WP-XP-1): reply / mark as read fire even from a killed app - the
  // OS briefly relaunches the process to deliver this callback. Both reuse the background
  // outbox-drain machinery, never open the app or a deep link.
  if ([response.actionIdentifier isEqualToString:kCanariReplyActionId]) {
    NSString *groupId =
        [userInfo[@"groupId"] isKindOfClass:[NSString class]] ? userInfo[@"groupId"] : @"";
    NSString *text = @"";
    if ([response isKindOfClass:[UNTextInputNotificationResponse class]]) {
      text = ((UNTextInputNotificationResponse *)response).userText ?: @"";
    }
    long long notifiedAt = CanariNotifiedSentAt(userInfo);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CanariHandleQuickReplyAction(groupId, [text stringByTrimmingCharactersInSet:
                                                        [NSCharacterSet whitespaceAndNewlineCharacterSet]],
                                   notifiedAt);
      completionHandler();
    });
    return;
  }
  if ([response.actionIdentifier isEqualToString:kCanariMarkReadActionId]) {
    NSString *groupId =
        [userInfo[@"groupId"] isKindOfClass:[NSString class]] ? userInfo[@"groupId"] : @"";
    long long notifiedAt = CanariNotifiedSentAt(userInfo);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CanariHandleMarkReadAction(groupId, notifiedAt);
      completionHandler();
    });
    return;
  }

  NSString *deepLink = CanariTapDeepLink(userInfo);
  // THE TAP OPENS WHAT THE PAYLOAD NAMES (its `deepLink`, else the conversation its clear fields name,
  // `CanariTapDeepLink`), so an absent link is a payload that lost its field and says so: a post,
  // form or agenda push used to arrive with none (the server sent only postId / formId) and the tap
  // launched the app and stayed put, with nothing in the log.
  // A deep link carries ids, tokens and query parameters: the log names its SHAPE only (scheme +
  // host, and whether a query was present), never the path or the values.
  NSLog(@"[CanariPush] notification tap type=%@ deepLink=%@", userInfo[@"type"] ?: @"?",
        deepLink.length > 0 ? CanariDescribeDeepLink(deepLink)
                            : @"ABSENT - the payload names no target");
  if (deepLink.length > 0) {
    NSURL *url = [NSURL URLWithString:deepLink];
    if (url != nil) {
      dispatch_async(dispatch_get_main_queue(), ^{
        [[UIApplication sharedApplication] openURL:url
                                           options:@{}
                                 completionHandler:^(BOOL success) {
                                   // The system's answer to the self-open: NO means it declined.
                                   NSLog(@"[CanariPush] notification tap: openURL completed success=%d", success);
                                 }];
      });
    } else {
      NSLog(@"[CanariPush] notification tap: deepLink is not a URL: %@",
            CanariDescribeDeepLink(deepLink));
    }
  }
  completionHandler();
}
@end

static CanariNotificationDelegate *g_notifDelegate = nil;

void CanariPushSetup(void) {
  g_mlsStateLock = [[NSLock alloc] init];
  g_cacheLock = [[NSLock alloc] init];
  g_notifDelegate = [[CanariNotificationDelegate alloc] init];
  [UNUserNotificationCenter currentNotificationCenter].delegate = g_notifDelegate;
  CanariRefreshNotificationCategories();
  // Incoming-call ring (WP-XP-5): PushKit VoIP registry + CallKit provider + handover hook.
  if (kCanariCallsEnabled) {
    CanariCallKitSetup();
  } else {
    NSLog(@"[CanariCallKit] calls disabled - PushKit registry and CallKit provider not installed");
  }

  [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                BOOL added = CanariInstallRemoteNotificationHook();
#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
                CanariInstallApnsTokenHook();
#endif
                // AFTER every method is added, once: a background launch for a silent frame
                // delivers it right after this notification, so UIKit must already see the method.
                if (added) {
                  CanariReassignAppDelegate();
                }
              }];
  [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                CanariLogAppDelegateIdentity();
              }];

#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
  g_fcmPushDelegate = [[CanariFcmPushDelegate alloc] init];
  [FIRMessaging messaging].delegate = g_fcmPushDelegate;
  NSLog(@"[CanariPush] FCM delegate installed");
  // THE TOKEN IS NOT FETCHED HERE, and that is the fix rather than an omission. This block used to
  // call `tokenWithCompletion` on the spot, declaring itself the peer of Android's
  // MainActivity.onCreate force-read - but it copied a pattern whose precondition exists only on the
  // platform it was copied TO. Android reads its token at launch with nothing to wait for; iOS
  // cannot produce one before APNs answers, and APNs is not even asked until
  // `registerForRemoteNotifications` runs on DidFinishLaunching, which is AFTER this function. So
  // the call could not succeed, failed with "No APNS token specified before fetching FCM Token",
  // logged one line nobody could read on a device, and returned without writing. Measured
  // 2026-08-27: `push_token` had 49 android rows and had never held one ios row.
  // CanariSyncFcmTokenIfApnsReady below does the same work where the precondition can hold.
#else
  NSLog(@"[CanariPush] Firebase Messaging absent");
#endif
}

// --- A sign-out ends this device's push registration ------------------------------------------
//
// The iOS half of `push_registration.rs`, which writes both marks, strips the account's push files
// (the App Group copies included) and then sends `+endForSignOut`. What only this side can do: erase
// the Keychain push secret, and delete the FCM token so FCM stops delivering to this install for the
// account that left. The deletion needs the network, so it is OWED until it succeeds - the
// `push_token_deletion_owed` mark is the durable record, completed by `startPushService` (through
// `+completeOwedDeletion`) before it registers, and by every activation below before the old token
// could be mirrored again.
//
// Both methods BLOCK on the FCM completion, which FIRMessaging delivers on the main queue - so they
// refuse the main thread rather than deadlock it. Rust calls them from a blocking worker thread.

/// How long one attempt waits on FCM. The owed mark, not this bound, is what makes it complete.
static const int64_t kCanariPushDeleteTimeoutSec = 30;

/// The body of `+completeOwedDeletion`, run under its lock with the mark known to be on disk.
static BOOL CanariCompleteOwedDeletionLocked(void) {
#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    NSLog(@"[CanariPush] ERROR: no data directory - the token deletion stays owed");
    return NO;
  }
  // FIRMessaging holds no token at all (APNs never answered, or it was already deleted): there is
  // no registration to end, and deleteToken would only fail on the absence.
  if ([FIRMessaging messaging].FCMToken != nil) {
    dispatch_semaphore_t answered = dispatch_semaphore_create(0);
    __block NSError *failure = nil;
    [[FIRMessaging messaging] deleteTokenWithCompletion:^(NSError *_Nullable error) {
      failure = error;
      dispatch_semaphore_signal(answered);
    }];
    long timedOut = dispatch_semaphore_wait(
        answered, dispatch_time(DISPATCH_TIME_NOW, kCanariPushDeleteTimeoutSec * NSEC_PER_SEC));
    if (timedOut != 0) {
      NSLog(@"[CanariPush] ERROR: FCM deleteToken did not answer - the token deletion stays owed");
      return NO;
    }
    if (failure != nil) {
      NSLog(@"[CanariPush] ERROR: FCM deleteToken failed - still owed: %@",
            CanariErrorReason(failure));
      return NO;
    }
  } else {
    NSLog(@"[CanariPush] no FCM token held - nothing to delete");
  }
  // An activation may have mirrored the old token while the deletion was owed; it is dead now.
  NSFileManager *fm = [NSFileManager defaultManager];
  [fm removeItemAtPath:[dir stringByAppendingPathComponent:@"fcm_token.txt"] error:nil];
  NSError *removeError = nil;
  NSString *owed = [dir stringByAppendingPathComponent:kPushTokenDeletionOwedFileName];
  if (![fm removeItemAtPath:owed error:&removeError] && [fm fileExistsAtPath:owed]) {
    NSLog(@"[CanariPush] ERROR: token deleted but the owed mark was not removed: %@",
          CanariErrorReason(removeError));
    return NO;
  }
  NSLog(@"[CanariPush] FCM token deleted - this install is no longer the previous account's push "
        @"destination");
  // The token the next sign-in registers, fetched under the lock so no other deletion runs between
  // the fetch and the mirror. Only once APNs has answered: before that FIRMessaging cannot mint
  // one, and the APNs callback (`CanariSyncFcmTokenIfApnsReady`) fetches it as soon as it can - so
  // a deletion on a cold start never waits on APNs. No server learns the token here: the stripped
  // push context is what keeps CanariPersistFcmToken from refreshing it on the backend.
  if ([FIRMessaging messaging].APNSToken == nil) {
    NSLog(@"[CanariPush] APNs not answered yet - the fresh FCM token is fetched when it does");
    return YES;
  }
  dispatch_semaphore_t fetched = dispatch_semaphore_create(0);
  __block NSString *fresh = nil;
  [[FIRMessaging messaging] tokenWithCompletion:^(NSString *_Nullable token,
                                                  NSError *_Nullable error) {
    if (error == nil) {
      fresh = token;
    }
    dispatch_semaphore_signal(fetched);
  }];
  if (dispatch_semaphore_wait(fetched, dispatch_time(DISPATCH_TIME_NOW,
                                                     kCanariPushDeleteTimeoutSec * NSEC_PER_SEC)) !=
          0 ||
      fresh.length == 0) {
    NSLog(@"[CanariPush] no fresh FCM token yet - the next activation fetches it");
    return YES;
  }
  CanariPersistFcmToken(fresh);
  return YES;
#else
  NSLog(@"[CanariPush] Firebase Messaging absent - no FCM token to delete");
  return YES;
#endif
}

@interface CanariPushRegistrationEnd : NSObject
+ (BOOL)endForSignOut;
+ (BOOL)completeOwedDeletion;
@end

@implementation CanariPushRegistrationEnd

+ (BOOL)endForSignOut {
  NSLog(@"[CanariPush] sign-out: erasing the push secret and deleting the FCM token");
  CanariPushSecretErase();
  return [self completeOwedDeletion];
}

+ (BOOL)completeOwedDeletion {
  if (!CanariPushTokenDeletionOwed()) {
    return YES;
  }
  if ([NSThread isMainThread]) {
    NSLog(@"[CanariPush] ERROR: token deletion asked on the main thread - refused, still owed");
    return NO;
  }
  // ONE DELETION AT A TIME, PROCESS-WIDE: the sign-out, `startPushService` and an activation can
  // all owe it at once, and two interleaved runs could each delete a token and fetch a fresh one,
  // leaving the mirror naming a token a later deletion killed. The mark is read again INSIDE the
  // lock, so a caller that waited finds the work done; the fresh token is fetched inside it too.
  @synchronized(self) {
    if (!CanariPushTokenDeletionOwed()) {
      NSLog(@"[CanariPush] token deletion completed by another caller");
      return YES;
    }
    return CanariCompleteOwedDeletionLocked();
  }
}

@end

void CanariSyncFcmTokenIfApnsReady(void) {
#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
  // The guard, and the reason this needs no timer and no retry count: the APNs token either has
  // arrived or it has not, `didBecomeActive` fires again on every foreground, and
  // didReceiveRegistrationToken covers the first acquisition independently. Nothing here waits.
  if ([FIRMessaging messaging].APNSToken == nil) {
    // Expected once per cold start: the first activation runs before APNs answers (about 40 ms
    // later on the iPhone 12, 2026-10-15), and that answer fetches the token itself. Seen on a
    // LATER activation, or with no "APNs token received" after it, APNs never answered.
    NSLog(@"[CanariPush] APNs token not here yet - the FCM token is fetched when it arrives");
    CanariWritePushDiagnostic(@"no-apns-token");
    return;
  }
  // A SIGN-OUT THAT COULD NOT DELETE ITS TOKEN IS COMPLETED HERE, and the old token is not mirrored:
  // it belongs to the account that left. AFTER the APNs guard, so on a cold start it runs from the
  // APNs callback rather than the first activation; `startPushService` completes it on its own
  // before any registration either way. The deletion fetches the fresh token.
  if (CanariPushTokenDeletionOwed()) {
    NSLog(@"[CanariPush] FCM token deletion owed by a sign-out - completing it");
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      [CanariPushRegistrationEnd completeOwedDeletion];
    });
    return;
  }
  [[FIRMessaging messaging] tokenWithCompletion:^(NSString *_Nullable token,
                                                  NSError *_Nullable error) {
    if (error != nil) {
      // APNs answered and FCM still refused - a different fault entirely from the guard above,
      // and the reason the report has to carry which of the two it was.
      NSLog(@"[CanariPush] fetching the FCM token failed: %@", CanariErrorReason(error));
      CanariWritePushDiagnostic(@"fcm-token-fetch-failed");
      return;
    }
    // Persisting an unchanged token is deliberate and cheap: this is the ONLY path that covers a
    // token which rotated while the app was killed, where didReceiveRegistrationToken never fires
    // because, from this launch's point of view, nothing changed.
    CanariPersistFcmToken(token);
    NSLog(@"[CanariPush] FCM token synchronised");
  }];
#else
  NSLog(@"[CanariPush] Firebase Messaging absent - no FCM token to sync");
#endif
}

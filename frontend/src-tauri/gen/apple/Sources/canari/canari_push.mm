#import "canari_push.h"
#import "canari_ios.h"
#import "canari_rust_bridge.h"

#import <CallKit/CallKit.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <PushKit/PushKit.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>

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
static const NSUInteger kMaxFcmCacheEntries = 50;
static const int kWelcomeRaceRetries = 3;
static const useconds_t kWelcomeRaceRetryDelayUs = 1800000;
static NSString *const kOutboxPendingFileName = @"outbox_pending.ndjson";
static NSString *const kOutboxSentFileName = @"outbox_sent.ndjson";
// BGProcessingTask identifier; MUST match BGTaskSchedulerPermittedIdentifiers in Info.plist.
// iOS analogue of Android's expedited MlsBackgroundWorker (WorkManager): given a background
// window by the OS, it drains mls_pending.db via canari_native_cleanup_pending_db.
static NSString *const kCanariBgCleanupTaskId = @"fr.emse.canari.cleanup";
static const int kPendingSyncNotifId = 9998;
static const NSTimeInterval kAvatarCacheMaxAgeSec = 24 * 60 * 60;

// Notification quick actions (WP-XP-1): inline reply / mark as read from the notification.
static NSString *const kCanariMessageCategoryId = @"canari_message_category";
static NSString *const kCanariReplyActionId = @"CANARI_REPLY_ACTION";
static NSString *const kCanariMarkReadActionId = @"CANARI_MARK_READ_ACTION";
static NSString *const kFcmCacheGroupIdKey = @"groupId";
static NSString *const kFcmCacheMessageIdKey = @"messageId";

static NSLock *g_mlsStateLock = nil;
static NSLock *g_cacheLock = nil;

@interface CanariPushContext : NSObject
@property(nonatomic, copy) NSString *pin;
@property(nonatomic, copy) NSString *userId;
@property(nonatomic, copy) NSString *deviceId;
@property(nonatomic, copy) NSString *baseUrl;
@end

@implementation CanariPushContext
@end

@interface CanariDecryptedMessage : NSObject
@property(nonatomic, copy) NSString *text;
@property(nonatomic, copy) NSString *messageId;
@property(nonatomic, assign) long long sentAt;
@property(nonatomic, copy) NSString *type;
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

NSString *CanariRetrievePushSecret(void) {
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

  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return nil;
  }
  NSString *path = [dir stringByAppendingPathComponent:kPendingPushSecretFileName];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    return nil;
  }
  NSData *raw = [NSData dataWithContentsOfFile:path];
  if (raw == nil) {
    return nil;
  }
  NSString *secret = [[[NSString alloc] initWithData:raw encoding:NSUTF8StringEncoding]
      stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (secret.length == 0) {
    return nil;
  }
  CanariPushSecretStore(secret);
  NSMutableData *zeros = [NSMutableData dataWithLength:raw.length];
  [zeros writeToFile:path atomically:YES];
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  NSLog(@"[CanariPush] secret migre depuis pending_push_secret.txt");
  return secret;
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
  NSString *pin = [dict[@"pin"] isKindOfClass:[NSString class]] ? dict[@"pin"] : @"";
  NSString *userId = [dict[@"userId"] isKindOfClass:[NSString class]] ? dict[@"userId"] : @"";
  NSString *deviceId = [dict[@"deviceId"] isKindOfClass:[NSString class]] ? dict[@"deviceId"] : @"";
  NSString *baseUrl = [dict[@"baseUrl"] isKindOfClass:[NSString class]] ? dict[@"baseUrl"] : @"";
  if (pin.length == 0 || userId.length == 0 || deviceId.length == 0 || baseUrl.length == 0) {
    return nil;
  }
  CanariPushContext *ctx = [[CanariPushContext alloc] init];
  ctx.pin = pin;
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
static NSString *const kChannelKeysFileName = @"channel_keys.json";
static NSString *const kAppGroupPushSecretFileName = @"push_secret.txt";

void CanariMirrorPushStateToAppGroup(void) {
  NSURL *container = [[NSFileManager defaultManager]
      containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
  if (container == nil) {
    NSLog(@"[CanariPush] mirror: App Group indisponible (entitlement manquant ?)");
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
  for (NSString *name in @[ kMlsBinFileName, kPushContextFileName, kChannelKeysFileName ]) {
    NSData *data = [NSData dataWithContentsOfFile:[src stringByAppendingPathComponent:name]];
    if (data == nil) {
      continue;
    }
    NSError *err = nil;
    if (![data writeToURL:[container URLByAppendingPathComponent:name] options:opts error:&err]) {
      NSLog(@"[CanariPush] mirror %@ echoue: %@", name, err.localizedDescription);
    }
  }
  // The push secret lives in the Keychain (app-only). Copy it into the container so the NSE
  // can authenticate the backend fetch paths (omitted proto, commit catch-up, avatar); the
  // common inline-ciphertext decrypt needs no secret.
  NSString *secret = CanariRetrievePushSecret();
  if (secret.length > 0) {
    [[secret dataUsingEncoding:NSUTF8StringEncoding]
        writeToURL:[container URLByAppendingPathComponent:kAppGroupPushSecretFileName]
           options:opts
             error:nil];
  }
  NSLog(@"[CanariPush] mirror App Group termine");
}

static NSString *CanariBuildFallbackText(NSString *senderName) {
  if (senderName.length > 0) {
    return [NSString stringWithFormat:@"Nouveau message de %@", senderName];
  }
  return @"Vous avez recu un message chiffre";
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
      dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 6 * NSEC_PER_SEC));
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
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 6 * NSEC_PER_SEC));
    return commitsJson;
  } @catch (NSException *ex) {
    NSLog(@"[CanariPush] fetchCommits exception: %@", ex.reason);
    return nil;
  }
}

static CanariDecryptedMessage *_Nullable CanariDecryptProto(CanariPushContext *ctx, NSString *groupId,
                                                           NSString *protoB64, NSData *stateBytes) {
  NSData *cipher =
      [[NSData alloc] initWithBase64EncodedString:protoB64
                                          options:NSDataBase64DecodingIgnoreUnknownCharacters];
  if (cipher == nil || cipher.length == 0) {
    return nil;
  }

  char *jsonPtr = canari_native_decrypt_message(
      (const unsigned char *)stateBytes.bytes, stateBytes.length, ctx.pin.UTF8String,
      ctx.userId.UTF8String, ctx.deviceId.UTF8String, groupId.UTF8String,
      (const unsigned char *)cipher.bytes, cipher.length);
  if (jsonPtr == nil) {
    return nil;
  }
  NSString *jsonStr = [NSString stringWithUTF8String:jsonPtr];
  canari_free_string(jsonPtr);
  return CanariParseDecryptedJson(jsonStr);
}

static CanariDecryptedMessage *_Nullable CanariTryDecrypt(NSString *queuedMessageId, NSString *groupId,
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
    NSLog(@"[CanariPush] tryDecrypt: MlsStateLock occupe");
    return nil;
  }
  CanariDecryptedMessage *result = nil;
  @try {
    NSData *stateBytes = CanariLoadMlsState();
    if (stateBytes == nil) {
      NSLog(@"[CanariPush] tryDecrypt: mls.bin absent");
    } else {
      result = CanariDecryptProto(ctx, groupId, protoB64, stateBytes);
    }
  } @finally {
    [g_mlsStateLock unlock];
  }
  return result;
}

// Parses the JSON from canari_native_decrypt_message_with_commits (mirror of CanariDecryptProto).
static CanariDecryptedMessage *_Nullable CanariDecryptProtoWithCommits(
    CanariPushContext *ctx, NSString *groupId, NSString *commitsJson, NSString *protoB64,
    NSData *stateBytes) {
  NSData *cipher =
      [[NSData alloc] initWithBase64EncodedString:protoB64
                                          options:NSDataBase64DecodingIgnoreUnknownCharacters];
  if (cipher == nil || cipher.length == 0) {
    return nil;
  }
  char *jsonPtr = canari_native_decrypt_message_with_commits(
      (const unsigned char *)stateBytes.bytes, stateBytes.length, ctx.pin.UTF8String,
      ctx.userId.UTF8String, ctx.deviceId.UTF8String, groupId.UTF8String, commitsJson.UTF8String,
      (const unsigned char *)cipher.bytes, cipher.length);
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
    NSString *queuedMessageId, NSString *groupId, NSString *_Nullable inlineProto) {
  if (queuedMessageId.length == 0 || groupId.length == 0) {
    return nil;
  }
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
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
    NSLog(@"[CanariPush] catchup: MlsStateLock occupe (epoch)");
    return nil;
  }
  @try {
    NSData *stateBytes = CanariLoadMlsState();
    if (stateBytes != nil) {
      epoch = canari_native_group_epoch((const unsigned char *)stateBytes.bytes, stateBytes.length,
                                        ctx.pin.UTF8String, ctx.userId.UTF8String,
                                        ctx.deviceId.UTF8String, groupId.UTF8String);
    }
  } @finally {
    [g_mlsStateLock unlock];
  }
  if (epoch < 0) {
    NSLog(@"[CanariPush] catchup: epoch inconnu group=%@", groupId);
    return nil;
  }

  // 2) Fetch the ordered commits since our epoch (outside the lock: HTTP).
  NSString *commitsJson = CanariFetchCommitsFromBackend(groupId, epoch, ctx);
  if (commitsJson.length == 0 || [commitsJson isEqualToString:@"[]"]) {
    NSLog(@"[CanariPush] catchup: aucun commit a rattraper (epoch=%lld)", epoch);
    return nil;
  }

  // 3) Apply the commits in memory and decrypt (brief lock).
  if (![g_mlsStateLock tryLock]) {
    NSLog(@"[CanariPush] catchup: MlsStateLock occupe (decrypt)");
    return nil;
  }
  CanariDecryptedMessage *result = nil;
  @try {
    NSData *stateBytes = CanariLoadMlsState();
    if (stateBytes != nil) {
      result = CanariDecryptProtoWithCommits(ctx, groupId, commitsJson, protoB64, stateBytes);
    }
  } @finally {
    [g_mlsStateLock unlock];
  }
  return result;
}

static void CanariWriteFcmCache(NSString *groupId, NSString *senderId, NSString *senderName,
                                CanariDecryptedMessage *msg) {
  if (msg.messageId.length == 0) {
    return;
  }
  NSMutableDictionary *entry = [@{
    @"groupId" : groupId ?: @"",
    @"messageId" : msg.messageId,
    @"senderId" : senderId ?: @"",
    @"senderName" : senderName ?: @"",
    @"content" : msg.text ?: @"",
    @"timestamp" : @(msg.sentAt),
    @"type" : msg.type ?: @"text",
  } mutableCopy];
  if (msg.mediaKind.length > 0) {
    entry[@"mediaKind"] = msg.mediaKind;
  }

  NSData *entryData = [NSJSONSerialization dataWithJSONObject:entry options:0 error:nil];
  if (entryData == nil) {
    return;
  }
  NSString *entryLine =
      [[NSString alloc] initWithData:entryData encoding:NSUTF8StringEncoding];
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
    NSLog(@"[CanariPush] writeFcmCache messageId=%@", [msg.messageId substringToIndex:MIN((NSUInteger)8, msg.messageId.length)]);
  } @finally {
    [g_cacheLock unlock];
  }
}

/**
 * Reads `fcm_message_cache.ndjson` (bounded, written by `CanariWriteFcmCache` on every decrypted
 * push) and returns the messageIds cached for `groupId` - used by the "mark as read" quick action
 * (WP-XP-1) to know which messages to cover in the read receipt. iOS twin of Android's
 * readCachedMessageIdsForGroup in CanariNotificationActionReceiver.kt.
 */
static NSArray<NSString *> *CanariReadCachedMessageIdsForGroup(NSString *groupId) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil || groupId.length == 0) {
    return @[];
  }
  NSString *path = [dir stringByAppendingPathComponent:kFcmCacheFileName];
  NSMutableArray<NSString *> *messageIds = [NSMutableArray array];
  [g_cacheLock lock];
  @try {
    NSString *content = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
    if (content.length == 0) {
      return @[];
    }
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
      NSString *entryGroupId =
          [o[kFcmCacheGroupIdKey] isKindOfClass:[NSString class]] ? o[kFcmCacheGroupIdKey] : @"";
      NSString *messageId =
          [o[kFcmCacheMessageIdKey] isKindOfClass:[NSString class]] ? o[kFcmCacheMessageIdKey] : @"";
      if ([entryGroupId isEqualToString:groupId] && messageId.length > 0) {
        [messageIds addObject:messageId];
      }
    }
  } @finally {
    [g_cacheLock unlock];
  }
  return messageIds;
}

/**
 * Recomputes the app-icon badge (WP-XP-2) from the currently delivered chat notifications so it
 * always mirrors the number of distinct unread conversations. A conversation is keyed by its
 * per-conversation thread when the NSE delivered it (killed app), or by the stable request id when
 * the in-app path delivered it (flat "canari_messages" thread) - both are unique per conversation.
 * This is the app-process counterpart of the NSE's `content.badge` write (NotificationService.swift):
 * when the app is alive it owns the badge; when killed the NSE does.
 */
static void CanariUpdateAppBadge(void) {
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center getDeliveredNotificationsWithCompletionHandler:^(
              NSArray<UNNotification *> *_Nonnull delivered) {
    NSMutableSet<NSString *> *convKeys = [NSMutableSet set];
    for (UNNotification *n in delivered) {
      NSString *thread = n.request.content.threadIdentifier ?: @"";
      NSString *deepLink = n.request.content.userInfo[@"deepLink"] ?: @"";
      BOOL isChat = [thread isEqualToString:@"canari_messages"] ||
                    [deepLink hasPrefix:@"fr.emse.canari://chat"];
      if (!isChat) {
        continue;
      }
      [convKeys addObject:[thread isEqualToString:@"canari_messages"] ? n.request.identifier : thread];
    }
    NSUInteger count = convKeys.count;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (@available(iOS 16.0, *)) {
        [center setBadgeCount:count withCompletionHandler:nil];
      } else {
        [UIApplication sharedApplication].applicationIconBadgeNumber = (NSInteger)count;
      }
      NSLog(@"[CanariPush] updateAppBadge: badge=%lu", (unsigned long)count);
    });
  }];
}

static void CanariShowLocalNotification(NSString *title, NSString *body, NSString *deepLink,
                                      NSString *threadId, int notifId,
                                      NSString *_Nullable attachmentPath,
                                      NSString *_Nullable groupId, BOOL timeSensitive) {
  if (canari_ios_is_in_foreground() && [threadId isEqualToString:@"canari_messages"]) {
    return;
  }

  UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
  content.title = title.length > 0 ? title : @"Canari";
  content.body = body ?: @"";
  content.sound = [UNNotificationSound defaultSound];
  content.threadIdentifier = threadId;
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
      NSLog(@"[CanariPush] attachment error: %@", attachErr.localizedDescription);
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
           NSLog(@"[CanariPush] showNotification error: %@", error.localizedDescription);
         } else if ([threadId isEqualToString:@"canari_messages"]) {
           // Refresh the launcher badge (WP-XP-2) once this conversation's notification is live.
           CanariUpdateAppBadge();
         }
       }];
}

/**
 * Registers the `UNNotificationCategory` backing the message notification quick actions
 * (WP-XP-1): inline reply (text input) and mark as read. Only notifications built with
 * `groupId` set (see `CanariShowLocalNotification`) opt into this category - never a `channel_`
 * conversation (channels are server-authoritative, no MLS outbox to route a reply/receipt through).
 */
static void CanariRegisterNotificationCategories(void) {
  UNTextInputNotificationAction *replyAction =
      [UNTextInputNotificationAction actionWithIdentifier:kCanariReplyActionId
                                                     title:@"Repondre"
                                                   options:UNNotificationActionOptionNone
                                      textInputButtonTitle:@"Envoyer"
                                      textInputPlaceholder:@""];
  UNNotificationAction *markReadAction =
      [UNNotificationAction actionWithIdentifier:kCanariMarkReadActionId
                                            title:@"Marquer comme lu"
                                          options:UNNotificationActionOptionNone];
  UNNotificationCategory *category =
      [UNNotificationCategory categoryWithIdentifier:kCanariMessageCategoryId
                                              actions:@[ replyAction, markReadAction ]
                                    intentIdentifiers:@[]
                                              options:UNNotificationCategoryOptionNone];
  [[UNUserNotificationCenter currentNotificationCenter]
      setNotificationCategories:[NSSet setWithObject:category]];
  NSLog(@"[CanariPush] notification categories registered");
}

static void CanariCancelConversationNotification(NSString *groupId) {
  if (groupId.length == 0) {
    return;
  }
  int notifId = CanariStableNotifId(groupId);
  NSString *requestId = [NSString stringWithFormat:@"canari-%d", notifId];
  [[UNUserNotificationCenter currentNotificationCenter]
      removeDeliveredNotificationsWithIdentifiers:@[ requestId ]];
  [[UNUserNotificationCenter currentNotificationCenter]
      removePendingNotificationRequestsWithIdentifiers:@[ requestId ]];
  NSLog(@"[CanariPush] cancelConversationNotification group=%@", groupId);
  // Recompute the launcher badge (WP-XP-2) now that this conversation is read/cleared.
  CanariUpdateAppBadge();
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

static BOOL CanariAcquireAddLock(CanariPushContext *ctx, NSString *secret, NSString *groupId) {
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/acquire-add-lock",
                                                               ctx.baseUrl]];
  NSDictionary *payload =
      @{@"userId" : ctx.userId, @"deviceId" : ctx.deviceId, @"groupId" : groupId};
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  int status = 0;
  NSData *resp = CanariHttpRequest(@"POST", url, secret, body, &status);
  NSLog(@"[CanariPush] acquireAddLock: HTTP %d group=%@", status, groupId);
  if (status != 201 || resp == nil) {
    return NO;
  }
  id json = [NSJSONSerialization JSONObjectWithData:resp options:0 error:nil];
  return [json isKindOfClass:[NSDictionary class]] && [json[@"acquired"] boolValue];
}

static void CanariReleaseAddLock(CanariPushContext *ctx, NSString *secret, NSString *groupId) {
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/release-add-lock",
                                                               ctx.baseUrl]];
  NSDictionary *payload =
      @{@"userId" : ctx.userId, @"deviceId" : ctx.deviceId, @"groupId" : groupId};
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  int status = 0;
  CanariHttpRequest(@"DELETE", url, secret, body, &status);
  NSLog(@"[CanariPush] releaseAddLock: HTTP %d group=%@", status, groupId);
}

static NSString *_Nullable CanariFetchKeyPackage(CanariPushContext *ctx, NSString *secret,
                                                 NSString *targetUserId, NSString *targetDeviceId) {
  NSString *encodedReq =
      [ctx.userId stringByAddingPercentEncodingWithAllowedCharacters:
                       [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *encodedDev =
      [ctx.deviceId stringByAddingPercentEncodingWithAllowedCharacters:
                        [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *encodedTargetUser =
      [targetUserId stringByAddingPercentEncodingWithAllowedCharacters:
                          [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *encodedTargetDev =
      [targetDeviceId stringByAddingPercentEncodingWithAllowedCharacters:
                           [NSCharacterSet URLQueryAllowedCharacterSet]];
  NSString *urlStr = [NSString
      stringWithFormat:
          @"%@/api/mls/push/key-package?requesterId=%@&deviceId=%@&targetUserId=%@&targetDeviceId=%@",
          ctx.baseUrl, encodedReq, encodedDev, encodedTargetUser, encodedTargetDev];
  int status = 0;
  NSData *resp = CanariHttpRequest(@"GET", [NSURL URLWithString:urlStr], secret, nil, &status);
  if (status != 200 || resp == nil) {
    NSLog(@"[CanariPush] fetchKeyPackage: HTTP %d", status);
    return nil;
  }
  id json = [NSJSONSerialization JSONObjectWithData:resp options:0 error:nil];
  if (![json isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  NSString *kp = [json[@"keyPackage"] isKindOfClass:[NSString class]] ? json[@"keyPackage"] : @"";
  return kp.length > 0 ? kp : nil;
}

static BOOL CanariSendWelcomeAndCommit(CanariPushContext *ctx, NSString *secret, NSString *groupId,
                                       NSString *targetUserId, NSString *targetDeviceId,
                                       NSString *welcomePayload, NSString *_Nullable ratchetTree,
                                       NSString *commitPayload, long long baseEpoch) {
  NSURL *url =
      [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/send-welcome-and-commit",
                                                     ctx.baseUrl]];
  NSMutableDictionary *payload = [@{
    @"userId" : ctx.userId,
    @"deviceId" : ctx.deviceId,
    @"groupId" : groupId,
    @"targetUserId" : targetUserId,
    @"targetDeviceId" : targetDeviceId,
    @"welcomePayload" : welcomePayload,
    @"commitPayload" : commitPayload,
  } mutableCopy];
  payload[@"ratchetTreePayload"] = ratchetTree.length > 0 ? ratchetTree : [NSNull null];
  if (baseEpoch >= 0) {
    payload[@"baseEpoch"] = @(baseEpoch);
  }
  NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  int status = 0;
  CanariHttpRequest(@"POST", url, secret, body, &status);
  NSLog(@"[CanariPush] sendWelcomeAndCommit: HTTP %d group=%@", status, groupId);
  return status == 201;
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
    NSLog(@"[CanariPush] BGTask submit echoue: %@", error.localizedDescription);
  } else {
    NSLog(@"[CanariPush] BGTask cleanup planifie");
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
                          NSLog(@"[CanariPush] BGTask expire avant la fin du cleanup");
                        };
                        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                          CanariRunBackgroundCleanup();
                          [task setTaskCompletedWithSuccess:YES];
                        });
                      }];
  NSLog(@"[CanariPush] BGTask handler enregistre (%@)", kCanariBgCleanupTaskId);
}

#endif

void CanariRegisterBackgroundTasks(void) {
#if __has_include(<BackgroundTasks/BackgroundTasks.h>)
  if (@available(iOS 13.0, *)) {
    CanariRegisterBackgroundCleanupHandler();
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

static NSString *_Nullable CanariEncryptQueuedMessage(CanariPushContext *ctx, CanariOutboxEntry *entry) {
  if (![g_mlsStateLock tryLock]) {
    NSLog(@"[CanariPush] encryptQueuedMessage: MlsStateLock occupe");
    return nil;
  }
  NSString *ciphertext = nil;
  @try {
    NSString *dir = CanariTauriDataDir();
    NSData *stateBytes = CanariLoadMlsState();
    if (dir == nil || stateBytes == nil) {
      NSLog(@"[CanariPush] encryptQueuedMessage: etat MLS absent");
      return nil;
    }
    char *jsonPtr = canari_native_send_message_background(
        dir.UTF8String, (const unsigned char *)stateBytes.bytes, stateBytes.length,
        ctx.pin.UTF8String, ctx.userId.UTF8String, ctx.deviceId.UTF8String, entry.groupId.UTF8String,
        entry.proto.UTF8String);
    if (jsonPtr == nil) {
      return nil;
    }
    NSString *jsonStr = [NSString stringWithUTF8String:jsonPtr];
    canari_free_string(jsonPtr);
    NSData *jsonData = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
    id json = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
    if (![json isKindOfClass:[NSDictionary class]] || ![json[@"ok"] boolValue]) {
      NSLog(@"[CanariPush] encryptQueuedMessage: ok=false group=%@", entry.groupId);
      return nil;
    }
    NSString *ct = [json[@"ciphertext"] isKindOfClass:[NSString class]] ? json[@"ciphertext"] : @"";
    ciphertext = ct.length > 0 ? ct : nil;
  } @finally {
    [g_mlsStateLock unlock];
  }
  return ciphertext;
}

static BOOL CanariSendQueuedMessagePush(CanariPushContext *ctx, NSString *secret, NSString *groupId,
                                        NSString *ciphertextB64, NSString *messageId, BOOL silent) {
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/mls/push/send", ctx.baseUrl]];
  NSDictionary *payload = @{
    @"userId" : ctx.userId,
    @"deviceId" : ctx.deviceId,
    @"groupId" : groupId,
    @"proto" : ciphertextB64,
    @"messageId" : messageId,
    @"silent" : @(silent),
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
    NSLog(@"[CanariPush] drainOutboxBackground: pushSecret absent (%lu restants)",
          (unsigned long)entries.count);
    return (int)entries.count;
  }
  NSLog(@"[CanariPush] drainOutboxBackground: %lu message(s)", (unsigned long)entries.count);
  NSMutableArray<NSString *> *sentIds = [NSMutableArray array];
  NSMutableArray<CanariOutboxEntry *> *remaining = [NSMutableArray array];
  for (CanariOutboxEntry *entry in entries) {
    NSString *ciphertext = CanariEncryptQueuedMessage(ctx, entry);
    if (ciphertext == nil) {
      [remaining addObject:entry];
      continue;
    }
    if (CanariSendQueuedMessagePush(ctx, secret, entry.groupId, ciphertext, entry.entryId,
                                    entry.silent)) {
      [sentIds addObject:entry.entryId];
    } else {
      [remaining addObject:entry];
    }
  }
  if (sentIds.count > 0) {
    CanariAppendOutboxSent(sentIds);
  }
  CanariRewriteOutboxMirror(remaining);
  NSLog(@"[CanariPush] drainOutboxBackground: %lu envoye(s), %lu restant(s)",
        (unsigned long)sentIds.count, (unsigned long)remaining.count);
  return (int)remaining.count;
}

/**
 * Notification quick action (WP-XP-1): builds a plaintext text `AppMessage` proto for the typed
 * reply (via the Rust FFI, no TS runtime involved), queues it into the same `outbox_pending.ndjson`
 * mirror the composer writes to, and drains it immediately. The notification is cleared only once
 * actually delivered (drain returns 0 remaining) - a queued-but-undelivered reply must keep the
 * notification so the user can retry from the app. Android twin: handleReply in
 * CanariNotificationActionReceiver.kt.
 */
static void CanariHandleQuickReplyAction(NSString *groupId, NSString *text) {
  if (groupId.length == 0 || text.length == 0) {
    NSLog(@"[CanariPush] handleQuickReplyAction: groupId/text manquant");
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
    NSLog(@"[CanariPush] handleQuickReplyAction: nativeBuildTextMessageProto echoue");
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
  NSMutableArray<CanariOutboxEntry *> *entries = [CanariReadOutboxMirror() mutableCopy];
  [entries addObject:entry];
  CanariRewriteOutboxMirror(entries);
  NSLog(@"[CanariPush] handleQuickReplyAction: queued id=%@ group=%@",
        [messageId substringToIndex:MIN((NSUInteger)8, messageId.length)], groupId);

  int remaining = CanariDrainOutboxBackground(ctx);
  if (remaining == 0) {
    CanariCancelConversationNotification(groupId);
  } else {
    NSLog(@"[CanariPush] handleQuickReplyAction: reply still queued (remaining=%d) - notification left as-is",
          remaining);
  }
}

/**
 * Notification quick action (WP-XP-1): clears this device's local notification immediately
 * (visible part of "mark as read"), then best-effort sends a silent `read_receipt` system event for
 * every cached message of this conversation - reusing the same silent-push cross-device-cancel path
 * already used when a conversation is read in the foreground. No cached messageId (cache
 * evicted/never decrypted) -> notification is still cleared, just no receipt is sent. Android twin:
 * handleMarkRead in CanariNotificationActionReceiver.kt.
 */
static void CanariHandleMarkReadAction(NSString *groupId) {
  if (groupId.length == 0) {
    return;
  }
  CanariCancelConversationNotification(groupId);

  NSArray<NSString *> *messageIds = CanariReadCachedMessageIdsForGroup(groupId);
  if (messageIds.count == 0) {
    NSLog(@"[CanariPush] handleMarkReadAction: aucun messageId en cache group=%@ - notif effacee, pas de recu",
          groupId);
    return;
  }
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
    NSLog(@"[CanariPush] handleMarkReadAction: push_context.json absent -> abort recu");
    return;
  }
  NSData *idsData = [NSJSONSerialization dataWithJSONObject:messageIds options:0 error:nil];
  if (idsData == nil) {
    return;
  }
  NSString *idsJson = [[NSString alloc] initWithData:idsData encoding:NSUTF8StringEncoding];
  char *protoPtr = canari_native_build_read_receipt_proto(idsJson.UTF8String);
  if (protoPtr == nil) {
    NSLog(@"[CanariPush] handleMarkReadAction: nativeBuildReadReceiptProto echoue");
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
  entry.silent = YES;
  NSMutableArray<CanariOutboxEntry *> *entries = [CanariReadOutboxMirror() mutableCopy];
  [entries addObject:entry];
  CanariRewriteOutboxMirror(entries);
  CanariDrainOutboxBackground(ctx);
  NSLog(@"[CanariPush] handleMarkReadAction: read receipt queued+drained for %lu message(s) group=%@",
        (unsigned long)messageIds.count, groupId);
}

static void CanariShowPendingSyncNotification(void) {
  NSString *body =
      @"Vous avez peut-etre des messages en attente, ouvrez l'application pour les envoyer.";
  CanariShowLocalNotification(@"Canari", body, @"fr.emse.canari://chat", @"canari_messages",
                              kPendingSyncNotifId, nil, nil, NO);
  NSLog(@"[CanariPush] showPendingSyncNotification");
}

static void CanariMaybeNotifyPendingSync(int remaining) {
  if (remaining <= 0 || canari_ios_is_in_foreground()) {
    return;
  }
  CanariShowPendingSyncNotification();
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
  NSLog(@"[CanariPush] fetchAvatar: mis en cache %@", userId);
  return cachePath;
}

static void CanariProcessWelcomeRequestBackground(NSString *groupId, NSString *requesterUserId,
                                                  NSString *requesterDeviceId) {
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
    NSLog(@"[CanariPush] processWelcomeRequestBackground: push_context absent");
    return;
  }
  NSString *secret = CanariRetrievePushSecret();
  if (secret == nil) {
    NSLog(@"[CanariPush] processWelcomeRequestBackground: pushSecret absent");
    return;
  }

  BOOL lockAcquired = NO;
  for (int attempt = 0; attempt < 3; attempt++) {
    lockAcquired = CanariAcquireAddLock(ctx, secret, groupId);
    if (lockAcquired) {
      break;
    }
    usleep(2000000);
  }
  if (!lockAcquired) {
    NSLog(@"[CanariPush] processWelcomeRequestBackground: verrou Redis non acquis");
    return;
  }

  @try {
    NSString *keyPackage = CanariFetchKeyPackage(ctx, secret, requesterUserId, requesterDeviceId);
    if (keyPackage == nil) {
      NSLog(@"[CanariPush] processWelcomeRequestBackground: keyPackage absent");
      return;
    }

    if (![g_mlsStateLock tryLock]) {
      NSLog(@"[CanariPush] processWelcomeRequestBackground: MlsStateLock occupe");
      return;
    }
    NSDictionary *result = nil;
    @try {
      NSString *dir = CanariTauriDataDir();
      NSData *stateBytes = CanariLoadMlsState();
      if (dir == nil || stateBytes == nil) {
        NSLog(@"[CanariPush] processWelcomeRequestBackground: mls.bin absent");
        return;
      }
      char *jsonPtr = canari_native_create_welcome_background(
          dir.UTF8String, (const unsigned char *)stateBytes.bytes, stateBytes.length,
          ctx.pin.UTF8String, ctx.userId.UTF8String, ctx.deviceId.UTF8String, groupId.UTF8String,
          keyPackage.UTF8String);
      if (jsonPtr == nil) {
        return;
      }
      NSString *jsonStr = [NSString stringWithUTF8String:jsonPtr];
      canari_free_string(jsonPtr);
      id json = [NSJSONSerialization JSONObjectWithData:[jsonStr dataUsingEncoding:NSUTF8StringEncoding]
                                                  options:0
                                                    error:nil];
      if ([json isKindOfClass:[NSDictionary class]]) {
        result = json;
      }
    } @finally {
      [g_mlsStateLock unlock];
    }

    if (result == nil || ![result[@"ok"] boolValue]) {
      NSLog(@"[CanariPush] processWelcomeRequestBackground: create welcome echoue");
      return;
    }

    NSString *welcomePayload = result[@"welcome"];
    NSString *commitPayload = result[@"commit"];
    NSString *ratchetTree = [result[@"ratchetTree"] isKindOfClass:[NSString class]] ? result[@"ratchetTree"] : nil;
    if ([ratchetTree isEqualToString:@"null"]) {
      ratchetTree = nil;
    }
    long long baseEpoch = [result[@"baseEpoch"] respondsToSelector:@selector(longLongValue)]
                              ? [result[@"baseEpoch"] longLongValue]
                              : -1;

    BOOL sent = CanariSendWelcomeAndCommit(ctx, secret, groupId, requesterUserId, requesterDeviceId,
                                           welcomePayload, ratchetTree, commitPayload, baseEpoch);
    NSLog(@"[CanariPush] processWelcomeRequestBackground: send=%d group=%@", sent, groupId);
  } @finally {
    CanariReleaseAddLock(ctx, secret, groupId);
    int remaining = CanariDrainOutboxBackground(ctx);
    CanariMaybeNotifyPendingSync(remaining);
  }
}

static void CanariProcessReceivedWelcomeBackground(NSString *groupId, NSString *_Nullable queuedMessageId,
                                                   NSString *_Nullable inlineProto) {
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx == nil) {
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: push_context absent");
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
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: MlsStateLock occupe");
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
                 ctx.pin.UTF8String, ctx.userId.UTF8String, ctx.deviceId.UTF8String,
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
    NSLog(@"[CanariPush] processReceivedWelcomeBackground: echec join %@", groupId);
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

static void CanariShowMessageNotification(NSString *senderName, NSString *groupName, NSString *body,
                                          NSString *groupId, NSString *senderId,
                                          CanariDecryptedMessage *_Nullable decrypted) {
  if (canari_ios_is_in_foreground()) {
    return;
  }
  BOOL isGroup = groupName.length > 0 && ![groupName isEqualToString:senderName];
  NSString *title = isGroup ? groupName : (senderName.length > 0 ? senderName : @"Canari");
  NSString *deepLink =
      groupId.length > 0
          ? [NSString stringWithFormat:@"fr.emse.canari://chat/%@", groupId]
          : @"fr.emse.canari://chat";
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
  // @-mention of me (WP-XP-5): the decrypted body carries inline `@[uuid]` tokens; when one
  // targets my own userId the notification is delivered time-sensitive (Focus breakthrough).
  BOOL mentionsMe = NO;
  if (ctx != nil && ctx.userId.length > 0 && body.length > 0) {
    NSString *needle = [NSString stringWithFormat:@"@[%@]", ctx.userId];
    mentionsMe = [body rangeOfString:needle options:NSCaseInsensitiveSearch].location != NSNotFound;
  }
  CanariShowLocalNotification(title, body, deepLink, @"canari_messages", notifId, attachmentPath,
                              groupId, mentionsMe);
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
// {type:"call_ring", groupId, callId, callerName, groupName, hasVideo}. PushKit launches this app
// even from a killed state and Apple REQUIRES every VoIP push to immediately report a call to
// CallKit - the full-screen system ring UI. Answering cannot start audio directly (the MLS/WebRTC
// stack lives in the webview behind the PIN lock), so an answer records a pending accept
// (pending_call_accept.json, drained by the frontend after unlock via the
// `read_and_clear_pending_call_accept` Tauri command) and the CallKit session is closed as soon as
// the app becomes active - the in-app call UI takes over from there.

static NSString *const kVoipTokenFileName = @"voip_token.txt";
static NSString *const kPendingCallAcceptFileName = @"pending_call_accept.json";
static const int64_t kCallRingTimeoutSec = 60;

static CXProvider *g_callProvider = nil;
static PKPushRegistry *g_voipRegistry = nil;
/// callId -> CallKit UUID for calls currently ringing (or answered but not yet handed over).
static NSMutableDictionary<NSString *, NSUUID *> *g_ringingCalls = nil;
/// CallKit UUID string -> {groupId, callId, hasVideo} for the answer handler.
static NSMutableDictionary<NSString *, NSDictionary *> *g_ringingCallInfo = nil;

/// Ends a CallKit session for `callId` (remote hangup, answered elsewhere, timeout). No-op when
/// the call is not currently reported.
static void CanariEndCallKitCall(NSString *callId, CXCallEndedReason reason) {
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
    [g_callProvider reportCallWithUUID:uuid endedAtDate:nil reason:reason];
    NSLog(@"[CanariCallKit] call %@ ended (reason=%ld)", callId, (long)reason);
  });
}

@interface CanariCallProviderDelegate : NSObject <CXProviderDelegate>
@end

@implementation CanariCallProviderDelegate

- (void)providerDidReset:(CXProvider *)provider {
  (void)provider;
  [g_ringingCalls removeAllObjects];
  [g_ringingCallInfo removeAllObjects];
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
  BOOL hasVideo = [info[@"hasVideo"] boolValue];
  NSLog(@"[CanariCallKit] answer call=%@ group=%@", callId, groupId);

  NSString *dir = CanariTauriDataDir();
  if (dir != nil && groupId.length > 0) {
    NSDictionary *pending = @{
      @"groupId" : groupId,
      @"callId" : callId,
      @"hasVideo" : @(hasVideo),
      @"acceptedAt" : @((long long)([[NSDate date] timeIntervalSince1970] * 1000)),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:pending options:0 error:nil];
    [json writeToFile:[dir stringByAppendingPathComponent:kPendingCallAcceptFileName]
           atomically:YES];
  }
  [action fulfill];

  // Best-effort foreground: works when the app is unlocked/active contexts allow it; from the
  // lock screen the user lands in the app via the CallKit UI's app button instead.
  if (groupId.length > 0) {
    NSString *link = [NSString
        stringWithFormat:@"fr.emse.canari://chat/%@?acceptCall=%@&video=%d", groupId, callId,
                         hasVideo ? 1 : 0];
    NSURL *url = [NSURL URLWithString:link];
    if (url != nil) {
      dispatch_async(dispatch_get_main_queue(), ^{
        [[UIApplication sharedApplication] openURL:url options:@{} completionHandler:nil];
      });
    }
  }
}

/// User declined on the system UI: local dismiss only. In a group call "decline" means "stop
/// ringing me", never "end the call for everyone"; the caller stops via ring-end or timeout.
- (void)provider:(CXProvider *)provider performEndCallAction:(CXEndCallAction *)action {
  (void)provider;
  NSDictionary *info = g_ringingCallInfo[action.callUUID.UUIDString];
  NSString *callId = info[@"callId"] ?: @"";
  NSLog(@"[CanariCallKit] declined/ended call=%@", callId);
  if (callId.length > 0) {
    [g_ringingCalls removeObjectForKey:callId];
  }
  [g_ringingCallInfo removeObjectForKey:action.callUUID.UUIDString];
  [action fulfill];
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

/// Reports an incoming call to CallKit (full-screen system ring). Deduped per callId (the VoIP
/// push and the decrypted MLS invite may both arrive); auto-ends as unanswered after 60s.
static void CanariReportIncomingCall(NSString *groupId, NSString *callId, NSString *callerName,
                                     NSString *groupName, BOOL hasVideo) {
  if (callId.length == 0) {
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
      @"hasVideo" : @(hasVideo),
    };

    CXCallUpdate *update = [[CXCallUpdate alloc] init];
    NSString *display = callerName.length > 0 ? callerName : @"Canari";
    if (groupName.length > 0 && ![groupName isEqualToString:callerName]) {
      display = [NSString stringWithFormat:@"%@ - %@", display, groupName];
    }
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
                                                 error.localizedDescription);
                                           [g_ringingCalls removeObjectForKey:callId];
                                           [g_ringingCallInfo
                                               removeObjectForKey:uuid.UUIDString];
                                         } else {
                                           NSLog(@"[CanariCallKit] ringing call=%@ video=%d",
                                                 callId, hasVideo);
                                         }
                                       }];

    // Local ring timeout: CallKit has no built-in one. Only fires if still ringing.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, kCallRingTimeoutSec * NSEC_PER_SEC),
                   dispatch_get_main_queue(), ^{
                     if ([g_ringingCalls[callId] isEqual:uuid]) {
                       CanariEndCallKitCall(callId, CXCallEndedReasonUnanswered);
                     }
                   });
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
/// app is terminated (and eventually banned from VoIP pushes). A malformed payload therefore
/// still reports a call, immediately ended as failed.
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
  NSString *callerName =
      [data[@"callerName"] isKindOfClass:[NSString class]] ? data[@"callerName"] : @"";
  NSString *groupName =
      [data[@"groupName"] isKindOfClass:[NSString class]] ? data[@"groupName"] : @"";
  BOOL hasVideo = [data[@"hasVideo"] isKindOfClass:[NSString class]] &&
                  [data[@"hasVideo"] isEqualToString:@"true"];
  NSLog(@"[CanariCallKit] voip push type=%@ call=%@", msgType, callId);

  if ([msgType isEqualToString:@"call_ring"] && callId.length > 0) {
    CanariReportIncomingCall(groupId, callId, callerName, groupName, hasVideo);
  } else {
    // Contract keeper: report-and-kill a placeholder call for any unexpected payload.
    NSString *bogusId = callId.length > 0 ? callId : [[NSUUID UUID] UUIDString];
    CanariReportIncomingCall(groupId, bogusId, callerName, groupName, NO);
    CanariEndCallKitCall(bogusId, CXCallEndedReasonFailed);
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    completion();
  });
}

@end

static CanariVoipPushDelegate *g_voipPushDelegate = nil;

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
                // Handover: the webview (post-unlock) rings/joins via WS; a CallKit session left
                // open would show a dangling green bar. AnsweredElsewhere keeps call history sane.
                for (NSString *callId in [g_ringingCalls.allKeys copy]) {
                  CanariEndCallKitCall(callId, CXCallEndedReasonAnsweredElsewhere);
                }
              }];
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
  BOOL silent = [data[@"silent"] isEqualToString:@"true"];

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    CanariDecryptedMessage *decrypted = CanariTryDecrypt(queuedMessageId, groupId, inlineProto);
    int raceAttempt = 0;
    while (!silent && decrypted == nil && queuedMessageId.length > 0 &&
           raceAttempt < kWelcomeRaceRetries) {
      raceAttempt++;
      usleep(kWelcomeRaceRetryDelayUs);
      decrypted = CanariTryDecrypt(queuedMessageId, groupId, inlineProto);
    }

    if (silent) {
      CanariPushContext *ctx = CanariLoadPushContext();
      if (groupId.length > 0 && senderId.length > 0 && ctx != nil &&
          [senderId caseInsensitiveCompare:ctx.userId] == NSOrderedSame) {
        dispatch_async(dispatch_get_main_queue(), ^{
          CanariCancelConversationNotification(groupId);
        });
      } else {
        NSLog(@"[CanariPush] message silencieux - pas de notification");
      }
      return;
    }

    // Epoch gap: the direct decrypt failed. A frequent cause on a never-opened device is that a
    // device added to the group advanced the epoch (commit) that this device never applied in the
    // background (push decrypt is read-only). Attempt an in-memory commit catch-up (read-only,
    // mls.bin unchanged) to produce a real notification instead of the generic fallback.
    if (decrypted == nil && queuedMessageId.length > 0) {
      decrypted = CanariTryDecryptWithCommitCatchup(queuedMessageId, groupId, inlineProto);
    }

    // Call signaling over MLS (WP-XP-5, app running in background). Invite -> CallKit ring
    // (fallback for pre-WP-XP-5 callers that never hit POST /api/calls/ring; deduped per callId
    // with the VoIP push). Control -> never a message notification; hangup/answered also ends an
    // active CallKit ring.
    if (decrypted != nil && [decrypted.type isEqualToString:@"call_invite"]) {
      NSString *callId = decrypted.callId.length > 0
                             ? decrypted.callId
                             : [NSString stringWithFormat:@"mls-%@", groupId];
      CanariReportIncomingCall(groupId, callId, senderName, groupName, decrypted.hasVideo);
      return;
    }
    if (decrypted != nil && [decrypted.type isEqualToString:@"call_control"]) {
      if (decrypted.callEnded && decrypted.callId.length > 0) {
        CanariEndCallKitCall(decrypted.callId, CXCallEndedReasonRemoteEnded);
      }
      NSLog(@"[CanariPush] call_control supprime (ended=%d)", decrypted.callEnded);
      return;
    }

    NSString *body = decrypted.text;
    if (body.length == 0) {
      if (queuedMessageId.length > 0) {
        CanariRunBackgroundCleanup();
        NSLog(@"[CanariPush] dechiffrement echoue - cleanup pending db");
      }
      body = CanariBuildFallbackText(senderName);
    } else {
      CanariWriteFcmCache(groupId, senderId, senderName, decrypted);
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      CanariShowMessageNotification(senderName, groupName, body, groupId, senderId, decrypted);
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
  return [NSString stringWithFormat:@"Nouveau message dans #%@", channelName];
}

// Looks up the raw epoch key (base64) for a channel/keyVersion in the app-private channel_keys.json
// mirror (written by the foreground), or nil. Shape: { "<channelId>": { "<keyVersion>": "<keyB64>" } }.
static NSString *_Nullable CanariLookupChannelKey(NSString *channelId, NSString *keyVersion) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return nil;
  }
  NSData *raw =
      [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"channel_keys.json"]];
  if (raw == nil) {
    NSLog(@"[CanariPush] lookupChannelKey: channel_keys.json absent");
    return nil;
  }
  id json = [NSJSONSerialization JSONObjectWithData:raw options:0 error:nil];
  if (![json isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  id byChannel = ((NSDictionary *)json)[channelId];
  if (![byChannel isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  id key = ((NSDictionary *)byChannel)[keyVersion];
  return ([key isKindOfClass:[NSString class]] && [(NSString *)key length] > 0) ? key : nil;
}

// Decrypts a channel-message push (AES-256-GCM, not MLS) and shows a notification. The epoch key is
// read from channel_keys.json; the inline ciphertext is decrypted natively so the plaintext never
// transits FCM. Falls back to a generic body when the key is missing (channel not yet hydrated) or
// the ciphertext was omitted server-side. Mirror of Android handleChannelMessage.
static void CanariHandleChannelMessage(NSDictionary *data) {
  NSString *channelId =
      [data[@"channelId"] isKindOfClass:[NSString class]] ? data[@"channelId"] : @"";
  NSString *channelName = ([data[@"channelName"] isKindOfClass:[NSString class]] &&
                           [(NSString *)data[@"channelName"] length] > 0)
                              ? data[@"channelName"]
                              : @"Salon";
  NSString *keyVersion =
      [data[@"keyVersion"] isKindOfClass:[NSString class]] ? data[@"keyVersion"] : @"";
  NSString *ciphertext =
      [data[@"ciphertext"] isKindOfClass:[NSString class]] ? data[@"ciphertext"] : @"";
  NSString *nonce = [data[@"nonce"] isKindOfClass:[NSString class]] ? data[@"nonce"] : @"";
  NSString *senderId = [data[@"senderId"] isKindOfClass:[NSString class]] ? data[@"senderId"] : @"";
  if (channelId.length == 0) {
    NSLog(@"[CanariPush] handleChannelMessage: channelId manquant - abort");
    return;
  }
  // The app addresses channels as `channel_<uuid>`; use it for the deep link + stable notif id.
  NSString *conversationId = [NSString stringWithFormat:@"channel_%@", channelId];

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString *body = nil;
    NSString *keyB64 = (ciphertext.length > 0 && nonce.length > 0)
                           ? CanariLookupChannelKey(channelId, keyVersion)
                           : nil;
    if (keyB64.length > 0) {
      char *jsonPtr = canari_native_decrypt_channel_message(keyB64.UTF8String, nonce.UTF8String,
                                                            ciphertext.UTF8String);
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
          NSLog(@"[CanariPush] handleChannelMessage: decrypt ok=false channel=%@", channelId);
        }
      }
    } else {
      NSLog(@"[CanariPush] handleChannelMessage: pas de cle/ciphertext - notification generique "
            @"channel=%@",
            channelId);
    }
    if (body.length == 0) {
      body = CanariBuildChannelFallbackText(channelName);
    }

    NSString *displayName = [NSString stringWithFormat:@"#%@", channelName];
    dispatch_async(dispatch_get_main_queue(), ^{
      // groupName empty + senderName "#<channel>" -> title is "#<channel>"; avatar from senderId.
      // No media thumbnail for channels (WP-XP-3 is MLS DM/group only) -> pass nil.
      CanariShowMessageNotification(displayName, @"", body, conversationId, senderId, nil);
    });
  });
}

static void CanariHandleFcmData(NSDictionary *data) {
  if (data.count == 0) {
    return;
  }
  NSString *msgType = [data[@"type"] isKindOfClass:[NSString class]] ? data[@"type"] : @"";

  NSLog(@"[CanariPush] onMessage type=%@ action=%@ groupId=%@", msgType, data[@"action"],
        data[@"groupId"]);

  // Incoming-call ring signals (WP-XP-5), handled BEFORE the foreground guard: a ring-end must
  // clear an active CallKit session even when the app is foreground (the VoIP push reports
  // CallKit regardless of app state, per Apple's contract).
  if ([msgType isEqualToString:@"call_ring_end"]) {
    NSString *callId = [data[@"callId"] isKindOfClass:[NSString class]] ? data[@"callId"] : @"";
    NSString *reason = [data[@"reason"] isKindOfClass:[NSString class]] ? data[@"reason"] : @"";
    CanariEndCallKitCall(callId, [reason isEqualToString:@"answered"]
                                     ? CXCallEndedReasonAnsweredElsewhere
                                     : CXCallEndedReasonRemoteEnded);
    return;
  }
  // `call_ring` normally arrives as an APNs VoIP push (PushKit path); a legacy-registered device
  // (no voipToken yet) receives it via FCM instead. Foreground rings in-app via WS -> skip.
  if ([msgType isEqualToString:@"call_ring"]) {
    if (canari_ios_is_in_foreground()) {
      NSLog(@"[CanariPush] call_ring en foreground - overlay in-app sonne deja");
      return;
    }
    NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
    NSString *callId = [data[@"callId"] isKindOfClass:[NSString class]] ? data[@"callId"] : @"";
    NSString *callerName =
        [data[@"callerName"] isKindOfClass:[NSString class]] ? data[@"callerName"] : @"";
    NSString *groupName =
        [data[@"groupName"] isKindOfClass:[NSString class]] ? data[@"groupName"] : @"";
    if (callId.length > 0) {
      CanariReportIncomingCall(groupId, callId, callerName, groupName,
                               [data[@"hasVideo"] isEqualToString:@"true"]);
    }
    return;
  }

  if (canari_ios_is_in_foreground() && ![msgType isEqualToString:@"social"] &&
      ![msgType isEqualToString:@"form_reminder"]) {
    NSLog(@"[CanariPush] foreground actif - skip background MLS");
    return;
  }

  if ([msgType isEqualToString:@"welcome_request_pending"]) {
    NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
    NSString *requesterUser =
        [data[@"requesterUserId"] isKindOfClass:[NSString class]] ? data[@"requesterUserId"] : @"";
    NSString *requesterDev =
        [data[@"requesterDeviceId"] isKindOfClass:[NSString class]] ? data[@"requesterDeviceId"] : @"";
    if (groupId.length == 0 || requesterUser.length == 0 || requesterDev.length == 0) {
      NSLog(@"[CanariPush] welcome_request_pending: champs manquants");
      return;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CanariProcessWelcomeRequestBackground(groupId, requesterUser, requesterDev);
    });
    return;
  }

  if ([data[@"isWelcome"] isEqualToString:@"true"]) {
    NSString *groupId = [data[@"groupId"] isKindOfClass:[NSString class]] ? data[@"groupId"] : @"";
    NSString *queuedMessageId =
        [data[@"queuedMessageId"] isKindOfClass:[NSString class]] ? data[@"queuedMessageId"] : nil;
    NSString *inlineProto = [data[@"proto"] isKindOfClass:[NSString class]] ? data[@"proto"] : @"";
    if (groupId.length == 0) {
      NSLog(@"[CanariPush] isWelcome: groupId manquant");
      return;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CanariProcessReceivedWelcomeBackground(groupId, queuedMessageId, inlineProto);
    });
    return;
  }

  if ([msgType isEqualToString:@"social"] || [msgType isEqualToString:@"form_reminder"]) {
    NSString *title = [data[@"title"] isKindOfClass:[NSString class]] ? data[@"title"] : @"Canari";
    NSString *body = [data[@"body"] isKindOfClass:[NSString class]] ? data[@"body"] : @"";
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
    CanariShowLocalNotification(title, body, deepLink, thread, 0, nil, nil, NO);
    return;
  }

  // Community (channel) encrypted message: AES-256-GCM, key looked up in channel_keys.json.
  // Not MLS: no mls.bin, no state lock - decryption is stateless and read-only.
  if ([msgType isEqualToString:@"channel"]) {
    NSLog(@"[CanariPush] type=channel channelId=%@ - notification channel background",
          data[@"channelId"]);
    CanariHandleChannelMessage(data);
    return;
  }

  // Channel read on another of my devices: clear this device's notification for that channel
  // (cross-device read-state sync, channel counterpart of the MLS silent-receipt path). The reading
  // device is foreground and already returned above; only background sibling devices reach here.
  if ([msgType isEqualToString:@"channel_read"]) {
    NSString *channelId =
        [data[@"channelId"] isKindOfClass:[NSString class]] ? data[@"channelId"] : @"";
    if (channelId.length > 0) {
      NSString *conversationId = [NSString stringWithFormat:@"channel_%@", channelId];
      NSLog(@"[CanariPush] type=channel_read - clearing notification channel=%@", channelId);
      dispatch_async(dispatch_get_main_queue(), ^{
        CanariCancelConversationNotification(conversationId);
      });
    }
    return;
  }

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
      if ([thread isEqualToString:@"canari_messages"] || thread.length == 0) {
        [ids addObject:n.request.identifier];
      }
    }
    if (ids.count > 0) {
      [center removeDeliveredNotificationsWithIdentifiers:ids];
    }
    // Clearing every message notification (app opened) drops the badge to 0 (WP-XP-2).
    CanariUpdateAppBadge();
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

typedef void (^CanariRemoteNotifCompletion)(UIBackgroundFetchResult);
static CanariRemoteNotifCompletion (*CanariOrigDidReceiveRemoteNotification)(
    id, SEL, UIApplication *, NSDictionary *, CanariRemoteNotifCompletion);

static void CanariSwizzledDidReceiveRemoteNotification(
    id self, SEL _cmd, UIApplication *application, NSDictionary *userInfo,
    CanariRemoteNotifCompletion completionHandler) {
  CanariPushProcessRemoteNotificationUserInfo(userInfo);
  if (CanariOrigDidReceiveRemoteNotification != nil) {
    CanariOrigDidReceiveRemoteNotification(self, _cmd, application, userInfo, completionHandler);
  } else if (completionHandler != nil) {
    completionHandler(UIBackgroundFetchResultNoData);
  }
}

/** Hooks wry's UIApplicationDelegate for silent `content-available` background frames. */
static void CanariInstallRemoteNotificationHook(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    id<UIApplicationDelegate> delegate = [UIApplication sharedApplication].delegate;
    if (delegate == nil) {
      NSLog(@"[CanariPush] remote notification hook: app delegate absent");
      return;
    }
    Class delegateClass = [delegate class];
    SEL sel = @selector(application:didReceiveRemoteNotification:fetchCompletionHandler:);
    Method method = class_getInstanceMethod(delegateClass, sel);
    if (method == nil) {
      NSLog(@"[CanariPush] remote notification hook: selector absent on %@", delegateClass);
      return;
    }
    CanariOrigDidReceiveRemoteNotification =
        (CanariRemoteNotifCompletion (*)(id, SEL, UIApplication *, NSDictionary *,
                                         CanariRemoteNotifCompletion))method_getImplementation(method);
    method_setImplementation(method, (IMP)CanariSwizzledDidReceiveRemoteNotification);
    NSLog(@"[CanariPush] remote notification hook installed on %@", delegateClass);
  });
}

#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
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
  CanariPushContext *ctx = CanariLoadPushContext();
  NSString *secret = CanariRetrievePushSecret();
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
#endif

@interface CanariNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation CanariNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:
             (void (^)(UNNotificationPresentationOptions options))completionHandler {
  (void)center;
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
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CanariHandleQuickReplyAction(groupId, [text stringByTrimmingCharactersInSet:
                                                        [NSCharacterSet whitespaceAndNewlineCharacterSet]]);
      completionHandler();
    });
    return;
  }
  if ([response.actionIdentifier isEqualToString:kCanariMarkReadActionId]) {
    NSString *groupId =
        [userInfo[@"groupId"] isKindOfClass:[NSString class]] ? userInfo[@"groupId"] : @"";
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CanariHandleMarkReadAction(groupId);
      completionHandler();
    });
    return;
  }

  NSString *deepLink = nil;
  if ([userInfo[@"deepLink"] isKindOfClass:[NSString class]]) {
    deepLink = userInfo[@"deepLink"];
  }
  if (deepLink.length > 0) {
    NSURL *url = [NSURL URLWithString:deepLink];
    if (url != nil) {
      dispatch_async(dispatch_get_main_queue(), ^{
        [[UIApplication sharedApplication] openURL:url options:@{} completionHandler:nil];
      });
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
  CanariRegisterNotificationCategories();
  // Incoming-call ring (WP-XP-5): PushKit VoIP registry + CallKit provider + handover hook.
  CanariCallKitSetup();

  [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                CanariInstallRemoteNotificationHook();
              }];

#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
  g_fcmPushDelegate = [[CanariFcmPushDelegate alloc] init];
  [FIRMessaging messaging].delegate = g_fcmPushDelegate;
  NSLog(@"[CanariPush] FCM delegate installe");
  // Launch-time force-fetch of the current FCM token. didReceiveRegistrationToken
  // only fires when the token CHANGES, so a token that rotated while the app was
  // killed would otherwise never re-register until the next natural rotation. This
  // mirrors Android MainActivity.onCreate's FirebaseMessaging.getInstance().token
  // read: best-effort, runs once per cold start, persists + re-registers on success.
  [[FIRMessaging messaging] tokenWithCompletion:^(NSString *_Nullable token,
                                                  NSError *_Nullable error) {
    if (error != nil) {
      NSLog(@"[CanariPush] fetch FCM token au lancement echoue: %@", error.localizedDescription);
      return;
    }
    CanariPersistFcmToken(token);
    NSLog(@"[CanariPush] FCM token synchronise au lancement");
  }];
#else
  NSLog(@"[CanariPush] Firebase Messaging absent");
#endif
}

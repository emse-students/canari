#import "canari_push.h"
#import "canari_ios.h"
#import "canari_rust_bridge.h"

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>

#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
#import <FirebaseMessaging/FirebaseMessaging.h>
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
static const int kPendingSyncNotifId = 9998;
static const NSTimeInterval kAvatarCacheMaxAgeSec = 24 * 60 * 60;

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
@end

@implementation CanariDecryptedMessage
@end

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
  NSString *text = [dict[@"text"] isKindOfClass:[NSString class]] ? dict[@"text"] : @"";
  if (text.length == 0) {
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
  msg.type = [dict[@"type"] isKindOfClass:[NSString class]] ? dict[@"type"] : @"text";
  id mediaKind = dict[@"mediaKind"];
  msg.mediaKind = [mediaKind isKindOfClass:[NSString class]] ? mediaKind : nil;
  return msg;
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
  NSString *text = [dict[@"text"] isKindOfClass:[NSString class]] ? dict[@"text"] : @"";
  if (text.length == 0) {
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
  msg.type = [dict[@"type"] isKindOfClass:[NSString class]] ? dict[@"type"] : @"text";
  id mediaKind = dict[@"mediaKind"];
  msg.mediaKind = [mediaKind isKindOfClass:[NSString class]] ? mediaKind : nil;
  return msg;
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

static void CanariShowLocalNotification(NSString *title, NSString *body, NSString *deepLink,
                                      NSString *threadId, int notifId,
                                      NSString *_Nullable attachmentPath) {
  if (canari_ios_is_in_foreground() && [threadId isEqualToString:@"canari_messages"]) {
    return;
  }

  UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
  content.title = title.length > 0 ? title : @"Canari";
  content.body = body ?: @"";
  content.sound = [UNNotificationSound defaultSound];
  content.threadIdentifier = threadId;

  if (deepLink.length > 0) {
    content.userInfo = @{@"deepLink" : deepLink};
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
         }
       }];
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

static void CanariShowPendingSyncNotification(void) {
  NSString *body =
      @"Vous avez peut-etre des messages en attente, ouvrez l'application pour les envoyer.";
  CanariShowLocalNotification(@"Canari", body, @"fr.emse.canari://chat", @"canari_messages",
                              kPendingSyncNotifId, nil);
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

static void CanariShowMessageNotification(NSString *senderName, NSString *groupName, NSString *body,
                                          NSString *groupId, NSString *senderId) {
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
  NSString *avatarPath = nil;
  CanariPushContext *ctx = CanariLoadPushContext();
  if (ctx != nil && senderId.length > 0) {
    avatarPath = CanariFetchAvatar(ctx, senderId);
  }
  CanariShowLocalNotification(title, body, deepLink, @"canari_messages", notifId, avatarPath);
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
      CanariShowMessageNotification(senderName, groupName, body, groupId, senderId);
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
      CanariShowMessageNotification(displayName, @"", body, conversationId, senderId);
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
    CanariShowLocalNotification(title, body, deepLink, thread, 0, nil);
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
@interface CanariFcmPushDelegate : NSObject <FIRMessagingDelegate>
@end

@implementation CanariFcmPushDelegate
- (void)messaging:(FIRMessaging *)messaging didReceiveRegistrationToken:(NSString *)fcmToken {
  (void)messaging;
  NSString *dir = CanariTauriDataDir();
  if (dir != nil && fcmToken.length > 0) {
  NSString *path = [dir stringByAppendingPathComponent:@"fcm_token.txt"];
    [fcmToken writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    CanariPushContext *ctx = CanariLoadPushContext();
    NSString *secret = CanariRetrievePushSecret();
    if (ctx != nil && secret != nil) {
      CanariRefreshTokenOnBackend(ctx, secret, fcmToken);
    }
  }
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
#else
  NSLog(@"[CanariPush] Firebase Messaging absent");
#endif
}

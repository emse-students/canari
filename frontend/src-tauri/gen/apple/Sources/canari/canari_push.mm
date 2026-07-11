#import "canari_push.h"
#import "canari_ios.h"
#import "canari_rust_bridge.h"

#import <Foundation/Foundation.h>
#import <Security/Security.h>
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

- (void)messaging:(FIRMessaging *)messaging
    didReceiveMessage:(FIRMessagingRemoteMessage *)remoteMessage {
  (void)messaging;
  NSDictionary *data = remoteMessage.appData;
  if (data == nil) {
    return;
  }
  CanariHandleFcmData(data);
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
  (void)notification;
  if (canari_ios_is_in_foreground()) {
    completionHandler(UNNotificationPresentationOptionNone);
  } else {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
  }
}
@end

static CanariNotificationDelegate *g_notifDelegate = nil;

void CanariPushSetup(void) {
  g_mlsStateLock = [[NSLock alloc] init];
  g_cacheLock = [[NSLock alloc] init];
  g_notifDelegate = [[CanariNotificationDelegate alloc] init];
  [UNUserNotificationCenter currentNotificationCenter].delegate = g_notifDelegate;

#if __has_include(<FirebaseMessaging/FirebaseMessaging.h>)
  g_fcmPushDelegate = [[CanariFcmPushDelegate alloc] init];
  [FIRMessaging messaging].delegate = g_fcmPushDelegate;
  NSLog(@"[CanariPush] FCM delegate installe");
#else
  NSLog(@"[CanariPush] Firebase Messaging absent");
#endif
}

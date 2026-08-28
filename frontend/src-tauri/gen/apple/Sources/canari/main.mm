#include "bindings/bindings.h"
#include "canari_ios.h"

// Firebase is configured from canari_ios_bootstrap() -> CanariSetupFirebaseIfAvailable()
// ([FIRApp configure], guarded by GoogleService-Info.plist presence). We do NOT define a
// UIApplicationDelegate here: Tauri/wry installs its own delegate via start_app(), so any
// delegate declared in this file would never be registered (dead code) and a second
// [FIRApp configure] would crash at launch.
//
// APNs<->FCM token bridging does NOT rely on Firebase's App Delegate Proxy, and the ORDER below is
// why. The proxy reads [UIApplication sharedApplication].delegate exactly once, under a
// dispatch_once, when [FIRApp configure] runs - which is here, in main(), BEFORE ffi::start_app()
// creates the application. It found nil on every launch this platform ever had, installed nothing,
// and every APNs token was dropped; no iPhone had ever registered an FCM token. The bridge is
// CanariInstallApnsTokenHook (canari_push.mm), which swizzles wry's delegate class itself on
// UIApplicationDidFinishLaunching - the first moment that delegate exists.
int main(int argc, char * argv[]) {
	canari_ios_bootstrap();
	ffi::start_app();
	return 0;
}

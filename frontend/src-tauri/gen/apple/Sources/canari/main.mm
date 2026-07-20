#include "bindings/bindings.h"
#include "canari_ios.h"

// Firebase is configured from canari_ios_bootstrap() -> CanariSetupFirebaseIfAvailable()
// ([FIRApp configure], guarded by GoogleService-Info.plist presence). We do NOT define a
// UIApplicationDelegate here: Tauri/wry installs its own delegate via start_app(), so any
// delegate declared in this file would never be registered (dead code) and a second
// [FIRApp configure] would crash at launch. APNs<->FCM token bridging relies on Firebase's
// App Delegate Proxy (FirebaseAppDelegateProxyEnabled, default on) swizzling wry's delegate.
int main(int argc, char * argv[]) {
	canari_ios_bootstrap();
	ffi::start_app();
	return 0;
}

#include "bindings/bindings.h"
#include "canari_ios.h"

#import <UIKit/UIKit.h>
#import <FirebaseCore/FirebaseCore.h>

@interface TauriAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation TauriAppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(nullable NSDictionary<UIApplicationLaunchOptionsKey,id> *)launchOptions {
    [FIRApp configure];
    
    return YES;
}
@end

int main(int argc, char * argv[]) {
	canari_ios_bootstrap();
	ffi::start_app();
	return 0;
}

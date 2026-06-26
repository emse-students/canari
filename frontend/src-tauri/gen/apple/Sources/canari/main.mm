#include "bindings/bindings.h"
#include "canari_ios.h"

int main(int argc, char * argv[]) {
	canari_ios_bootstrap();
	ffi::start_app();
	return 0;
}

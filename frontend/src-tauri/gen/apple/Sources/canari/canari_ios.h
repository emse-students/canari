#pragma once

/// Installs the iOS lifecycle observers and the push handler (Firebase when available).
/// Appele depuis `main.mm` avant `ffi::start_app()`.
void canari_ios_bootstrap(void);

/// True while the app is in the foreground (mirror of `MainActivity.isInForeground`).
bool canari_ios_is_in_foreground(void);

#ifdef __OBJC__
#import <Foundation/Foundation.h>
/// A notification tap that resumes the app: its link rides the foreground edge the resume publishes,
/// so the page does not read the conversation left on screen (`resumeOpening.svelte.ts`).
void CanariNoteResumeOpening(NSString *_Nonnull deepLink);
#endif

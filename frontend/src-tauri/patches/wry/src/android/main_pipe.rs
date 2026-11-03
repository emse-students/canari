// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use crate::{Error, InitializationScript, RGBA};
use crossbeam_channel::*;
use jni::{
  JNIEnv, JavaVM,
  errors::Result as JniResult,
  objects::{GlobalRef, JMap, JObject, JString},
};
use std::{
  collections::{BTreeMap, BTreeSet},
  ffi::c_void,
  os::unix::prelude::*,
  sync::{Arc, LazyLock, Mutex},
};

use super::{EVAL_CALLBACKS, EVAL_ID_GENERATOR, EvalCallback, WebviewId, find_class};

pub type ActivityId = i32;

// CANARI PATCH: UNBOUNDED, upstream `bounded(8)`. The ONLY consumer of this channel is the main
// looper (`MainPipe::recv`, registered in `onFirstActivityCreateWry`), and the main thread is also a
// PRODUCER (`onWebviewDestroy`, called from `WryActivity.onDestroy`). With a bound, a main-thread
// send into a full channel parks the one thread that could ever empty it: a deadlock, and Play's
// ANR f51255a5a831e715b4fc8d976e87be11 (`MainPipe::send` <- `onWebviewDestroy` on the main thread,
// the tao thread parked on the same full channel). An unbounded `send` never blocks - it fails only
// once the receiver is dropped, and this one is a static - so no thread can park here.
static CHANNEL: LazyLock<(
  Sender<(ActivityId, WebViewMessage)>,
  Receiver<(ActivityId, WebViewMessage)>,
)> = LazyLock::new(unbounded);
// CANARI PATCH: the WRITE end is non-blocking. The byte is a level signal - "messages may be
// waiting" - and `recv` drains EVERY queued message on each byte it reads. So a full pipe already
// holds an unread byte, which guarantees a later callback that drains whatever this send queued: a
// write refused with EAGAIN loses nothing, and the main thread can never block on its own pipe the
// way it could on the bounded channel above. The read end stays blocking, so the callback's one-byte
// read (which runs only once the fd is readable) keeps its exact upstream meaning.
pub static MAIN_PIPE: LazyLock<[OwnedFd; 2]> = LazyLock::new(|| {
  let mut pipe: [RawFd; 2] = Default::default();
  unsafe { libc::pipe(pipe.as_mut_ptr()) };
  unsafe {
    let flags = libc::fcntl(pipe[1], libc::F_GETFL);
    if flags < 0 || libc::fcntl(pipe[1], libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
      log::error!(
        "[WRY_MAIN_PIPE] could not make the wake pipe non-blocking: {}",
        std::io::Error::last_os_error()
      );
    }
  }
  unsafe { pipe.map(|fd| OwnedFd::from_raw_fd(fd)) }
});

#[derive(Clone)]
pub struct ActivityProxy {
  pub activity: GlobalRef,
  pub window_manager: GlobalRef,
  pub webview: Option<GlobalRef>,
  pub java_vm: *mut c_void,
}

unsafe impl Send for ActivityProxy {}

impl ActivityProxy {
  pub fn new(vm: JavaVM, activity: GlobalRef, window_manager: GlobalRef) -> Self {
    Self {
      activity,
      window_manager,
      webview: None,
      java_vm: vm.get_java_vm_pointer() as *mut _,
    }
  }
}

static ACTIVITY_PROXY: LazyLock<Mutex<BTreeMap<ActivityId, ActivityProxy>>> =
  LazyLock::new(|| Mutex::new(BTreeMap::new()));

pub fn activity_proxy(id: ActivityId) -> Option<ActivityProxy> {
  ACTIVITY_PROXY.lock().unwrap().get(&id).cloned()
}

fn remove_activity_proxy(id: ActivityId) {
  ACTIVITY_PROXY.lock().unwrap().remove(&id);
}

pub fn register_activity_proxy(
  vm: JavaVM,
  id: ActivityId,
  activity: GlobalRef,
  window_manager: GlobalRef,
) {
  let mut activity_proxy = ACTIVITY_PROXY.lock().unwrap();
  if let Some(proxy) = activity_proxy.get_mut(&id) {
    proxy.activity = activity;
    proxy.window_manager = window_manager;
    proxy.java_vm = vm.get_java_vm_pointer() as *mut _;
  } else {
    let proxy = ActivityProxy::new(vm, activity, window_manager);
    activity_proxy.insert(id, proxy);
  }
}

pub fn activity_id_for_window_manager(window_manager: JObject) -> Option<ActivityId> {
  for (activity_id, proxy) in ACTIVITY_PROXY.lock().unwrap().iter() {
    let vm = unsafe { JavaVM::from_raw(proxy.java_vm.cast()) }.unwrap();
    let mut env = vm.attach_current_thread_as_daemon().unwrap();
    let equals = env
      .call_method(
        proxy.window_manager.as_obj(),
        "equals",
        "(Ljava/lang/Object;)Z",
        &[(&window_manager).into()],
      )
      .and_then(|v| v.z())
      .unwrap_or_default();
    if equals {
      return Some(*activity_id);
    }
  }
  None
}

pub fn first_activity_id() -> Option<ActivityId> {
  ACTIVITY_PROXY.lock().unwrap().keys().next().cloned()
}

/// The WebView of an activity, or `None` when it has none - including when the activity is gone.
///
/// CANARI PATCH (upstream on `dev` as tauri-apps/wry#1846, in no release yet): upstream `unwrap`s
/// the activity lookup. `OnDestroy` removes the activity's proxy, but messages the tao thread queued
/// for that activity before the destroy are still in the channel behind it; the next one (an `Eval`,
/// typically) panicked here, inside the looper callback, where `ndk::utils::abort_on_panic` turns any
/// panic into SIGABRT - Play's crash e3697bc4ad55d069ebb94d3d4a528c34. Every caller already reads
/// `None` as "no WebView, nothing to do", which is exactly what a destroyed activity is.
///
/// The gone-activity branch logs ONCE per activity (`GONE_ACTIVITIES_LOGGED`): it is the evidence
/// that a message really reached a destroyed activity, and one line says that as well as a hundred.
/// A live activity whose WebView is not created yet answers `None` too, silently, as upstream does:
/// that is the ordinary state between `CreateWebView` being queued and handled, not a loss.
pub fn get_webview(activity_id: ActivityId) -> Option<GlobalRef> {
  let proxies = ACTIVITY_PROXY.lock().unwrap();
  match proxies.get(&activity_id) {
    Some(proxy) => proxy.webview.clone(),
    None => {
      if GONE_ACTIVITIES_LOGGED.lock().unwrap().insert(activity_id) {
        log::info!(
          "[WRY_MAIN_PIPE] no WebView for activity {activity_id}: it was destroyed, so its queued messages are dropped"
        );
      }
      None
    }
  }
}

/// CANARI PATCH: the activities whose "destroyed, messages dropped" line was already written.
static GONE_ACTIVITIES_LOGGED: LazyLock<Mutex<BTreeSet<ActivityId>>> =
  LazyLock::new(|| Mutex::new(BTreeSet::new()));

/// CANARI PATCH: answer a requester, logging when it is no longer listening.
///
/// Upstream `unwrap`ped every reply. A requester waits with `recv_timeout`; once it gave up, its
/// receiver is dropped and the send fails - and an `unwrap` there panics inside the looper callback,
/// which `abort_on_panic` turns into SIGABRT (the same signature as e3697bc4). The answer has no
/// one left to read it, so the loss is the log line.
fn reply<T>(tx: &Sender<T>, value: T, what: &str) {
  if tx.send(value).is_err() {
    log::error!("[WRY_MAIN_PIPE] the {what} requester stopped waiting before its answer");
  }
}

pub struct MainPipe<'a> {
  pub env: JNIEnv<'a>,
}

impl<'a> MainPipe<'a> {
  pub(crate) fn send(activity_id: ActivityId, message: WebViewMessage) {
    const BYTE: [u8; 1] = [0];
    if CHANNEL.0.send((activity_id, message)).is_ok() {
      let written = unsafe {
        libc::write(
          MAIN_PIPE[1].as_raw_fd(),
          BYTE.as_ptr() as *const _,
          BYTE.len(),
        )
      };
      // CANARI PATCH: EAGAIN means the pipe is full of unread wake bytes, so a drain is already
      // owed and will take this message too (see `MAIN_PIPE`). Any other failure is not that.
      if written < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::WouldBlock {
          log::error!("[WRY_MAIN_PIPE] wake write failed: {error}");
        }
      }
    }
  }

  /// Drain the messages queued when this wake-up began, on the main thread.
  ///
  /// CANARI PATCH, three changes from upstream's `while try_recv() { handle_message()? }`:
  /// - A JNI error on ONE message is logged and the drain goes on. Upstream returned it, and the
  ///   looper callback then unregistered itself, so a single failed call left nothing draining this
  ///   channel for the rest of the process. So this returns nothing: no failure here may stop the
  ///   drain.
  /// - A pending Java exception is checked after EVERY message, not only a failed one: several arms
  ///   swallow a JNI error (`unwrap_or_default`) and the `Jni` closures return nothing, and each can
  ///   leave an exception pending that would poison the next message's calls. It is described (its
  ///   stack is the evidence of which call threw) and cleared.
  /// - It handles at most the `len()` read on entry, so it TERMINATES even while other threads keep
  ///   sending. A message sent after that read is not lost: its send wrote its own wake byte, or
  ///   found the pipe full of unread ones - either way a later callback drains it.
  pub fn recv(&mut self) {
    let package = super::PACKAGE.get().unwrap();
    let pending = CHANNEL.1.len();
    for _ in 0..pending {
      let Ok((activity_id, message)) = CHANNEL.1.try_recv() else {
        // Only this thread receives, so `len()` messages are there; an empty channel here means
        // that premise broke.
        log::error!("[WRY_MAIN_PIPE] the channel held fewer messages than it reported");
        break;
      };
      if let Err(error) = self.handle_message(package, activity_id, message) {
        log::error!("[WRY_MAIN_PIPE] a message for activity {activity_id} failed: {error}");
      }
      self.clear_pending_exception(activity_id);
    }
  }

  /// CANARI PATCH: describe and clear a Java exception a message left pending.
  fn clear_pending_exception(&mut self, activity_id: ActivityId) {
    if !self.env.exception_check().unwrap_or(false) {
      return;
    }
    log::error!(
      "[WRY_MAIN_PIPE] a message for activity {activity_id} left a Java exception pending"
    );
    if let Err(describe) = self.env.exception_describe() {
      log::error!("[WRY_MAIN_PIPE] could not describe the pending exception: {describe}");
    }
    if let Err(clear) = self.env.exception_clear() {
      log::error!("[WRY_MAIN_PIPE] could not clear the pending exception: {clear}");
    }
  }

  fn handle_message(
    &mut self,
    package: &str,
    activity_id: ActivityId,
    message: WebViewMessage,
  ) -> JniResult<()> {
    match message {
      WebViewMessage::CreateWebView(attrs) => {
        let Some(ActivityProxy { activity, .. }) = activity_proxy(activity_id) else {
          #[cfg(debug_assertions)]
          eprintln!("no activity found for activity id: {}", activity_id);
          return Ok(());
        };
        let CreateWebViewAttributes {
          url,
          html,
          #[cfg(any(debug_assertions, feature = "devtools"))]
          devtools,
          transparent,
          background_color,
          headers,
          on_webview_created,
          autoplay,
          user_agent,
          initialization_scripts,
          id,
          javascript_disabled,
          ..
        } = attrs;

        let string_class = self.env.find_class("java/lang/String")?;
        let initialization_scripts_array = self.env.new_object_array(
          initialization_scripts.len() as i32,
          string_class,
          self.env.new_string("")?,
        )?;
        for (i, init_script) in initialization_scripts.into_iter().enumerate() {
          self.env.set_object_array_element(
            &initialization_scripts_array,
            i as i32,
            self.env.new_string(init_script.script)?,
          )?;
        }
        let id = self.env.new_string(id)?;
        // Create webview
        let rust_webview_class =
          find_class(&mut self.env, &activity, format!("{package}/RustWebView"))?;
        let webview = self.env.new_object(
          &rust_webview_class,
          "(Landroid/content/Context;[Ljava/lang/String;Ljava/lang/String;)V",
          &[
            (&activity).into(),
            (&initialization_scripts_array).into(),
            (&id).into(),
          ],
        )?;
        // get settings
        let web_settings = self
          .env
          .call_method(
            &webview,
            "getSettings",
            "()Landroid/webkit/WebSettings;",
            &[],
          )?
          .l()?;
        // set media autoplay
        self.env.call_method(
          &web_settings,
          "setMediaPlaybackRequiresUserGesture",
          "(Z)V",
          &[(!autoplay).into()],
        )?;
        // set user-agent
        if let Some(user_agent) = user_agent {
          let user_agent = self.env.new_string(user_agent)?;
          self.env.call_method(
            &web_settings,
            "setUserAgentString",
            "(Ljava/lang/String;)V",
            &[(&user_agent).into()],
          )?;
        }

        // disable javascript
        if javascript_disabled {
          self.env.call_method(
            &web_settings,
            "setJavaScriptEnabled",
            "(Z)V",
            &[false.into()],
          )?;
        }

        let webview_class_name = format!("{package}/RustWebView");
        self.env.call_method(
          &activity,
          "setWebView",
          format!("(L{webview_class_name};)V"),
          &[(&webview).into()],
        )?;
        // Navigation
        if let Some(u) = url {
          if let Ok(url) = self.env.new_string(u) {
            load_url(&mut self.env, &webview, &url, headers, true)?;
          }
        } else if let Some(h) = html {
          if let Ok(html) = self.env.new_string(h) {
            load_html(&mut self.env, &webview, &html)?;
          }
        }
        // Enable devtools
        #[cfg(any(debug_assertions, feature = "devtools"))]
        self.env.call_static_method(
          &rust_webview_class,
          "setWebContentsDebuggingEnabled",
          "(Z)V",
          &[devtools.into()],
        )?;
        if transparent {
          set_background_color(&mut self.env, &webview, (0, 0, 0, 0))?;
        } else if let Some(color) = background_color {
          set_background_color(&mut self.env, &webview, color)?;
        }
        // Create and set webview client
        let client_class_name = format!("{package}/RustWebViewClient");
        let rust_webview_client_class =
          find_class(&mut self.env, &activity, client_class_name.clone())?;
        let webview_client = self.env.new_object(
          &rust_webview_client_class,
          format!("(L{webview_class_name};Landroid/content/Context;)V"),
          &[(&webview).into(), (&activity).into()],
        )?;
        self.env.call_method(
          &webview,
          "setWebViewClient",
          "(Landroid/webkit/WebViewClient;)V",
          &[(&webview_client).into()],
        )?;
        // Create and set webchrome client
        let rust_webchrome_client_class = find_class(
          &mut self.env,
          &activity,
          format!("{package}/RustWebChromeClient"),
        )?;
        let web_chrome_client = self.env.new_object(
          &rust_webchrome_client_class,
          format!("(L{package}/WryActivity;Ljava/lang/String;)V"),
          &[(&activity).into(), (&id).into()],
        )?;
        self.env.call_method(
          &webview,
          "setWebChromeClient",
          "(Landroid/webkit/WebChromeClient;)V",
          &[(&web_chrome_client).into()],
        )?;

        // Add javascript interface (IPC)
        let ipc_class = find_class(&mut self.env, &activity, format!("{package}/Ipc"))?;
        let ipc = self.env.new_object(
          ipc_class,
          format!("(L{webview_class_name};L{client_class_name};)V"),
          &[(&webview).into(), (&webview_client).into()],
        )?;
        let ipc_str = self.env.new_string("ipc")?;
        self.env.call_method(
          &webview,
          "addJavascriptInterface",
          "(Ljava/lang/Object;Ljava/lang/String;)V",
          &[(&ipc).into(), (&ipc_str).into()],
        )?;

        // Set content view
        self.env.call_method(
          &activity,
          "setContentView",
          "(Landroid/view/View;)V",
          &[(&webview).into()],
        )?;

        if let Some(on_webview_created) = on_webview_created {
          if let Err(_e) = on_webview_created(super::Context {
            env: &mut self.env,
            activity: &activity,
            webview: &webview,
          }) {
            #[cfg(feature = "tracing")]
            tracing::warn!("failed to run webview created hook: {_e}");
          }
        }

        let webview = self.env.new_global_ref(webview)?;

        ACTIVITY_PROXY
          .lock()
          .unwrap()
          .get_mut(&activity_id)
          .unwrap()
          .webview
          .replace(webview);
      }
      WebViewMessage::Eval(script, callback) => {
        if let Some(webview) = get_webview(activity_id) {
          let id = EVAL_ID_GENERATOR.next() as i32;

          #[cfg(feature = "tracing")]
          let span = std::sync::Mutex::new(Some(SendEnteredSpan(
            tracing::debug_span!("wry::eval").entered(),
          )));

          EVAL_CALLBACKS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(
              id,
              Box::new(move |result| {
                #[cfg(feature = "tracing")]
                span.lock().unwrap().take();

                if let Some(callback) = &callback {
                  callback(result);
                }
              }),
            );

          let s = self.env.new_string(script)?;
          self.env.call_method(
            webview.as_obj(),
            "evalScript",
            "(ILjava/lang/String;)V",
            &[id.into(), (&s).into()],
          )?;
        }
      }
      WebViewMessage::SetBackgroundColor(background_color) => {
        if let Some(webview) = get_webview(activity_id) {
          set_background_color(&mut self.env, webview.as_obj(), background_color)?;
        }
      }
      WebViewMessage::GetWebViewVersion(tx) => {
        if let Some(activity) = activity_proxy(activity_id).map(|p| p.activity) {
          match self
            .env
            .call_method(activity, "getVersion", "()Ljava/lang/String;", &[])
            .and_then(|v| v.l())
            .and_then(|s| {
              let s = JString::from(s);
              self
                .env
                .get_string(&s)
                .map(|v| v.to_string_lossy().to_string())
            }) {
            Ok(version) => reply(&tx, Ok(version), "WebView version"),
            Err(e) => reply(&tx, Err(e.into()), "WebView version"),
          }
        } else {
          reply(&tx, Err(Error::ActivityNotFound), "WebView version");
        }
      }
      WebViewMessage::GetUrl(tx) => {
        if let Some(webview) = get_webview(activity_id) {
          let url = self
            .env
            .call_method(webview.as_obj(), "getUrl", "()Ljava/lang/String;", &[])
            .and_then(|v| v.l())
            .and_then(|s| {
              let s = JString::from(s);
              self
                .env
                .get_string(&s)
                .map(|v| v.to_string_lossy().to_string())
            })
            .unwrap_or_default();

          reply(&tx, url, "URL");
        }
      }
      WebViewMessage::Jni(f) => {
        match activity_proxy(activity_id).map(|p| (p.activity.clone(), p.webview)) {
          Some((activity, Some(webview))) => {
            f(&mut self.env, &activity, webview.as_obj());
          }
          Some((activity, None)) => {
            f(&mut self.env, &activity, &JObject::null());
          }
          _ => {
            f(&mut self.env, &JObject::null(), &JObject::null());
          }
        }
      }
      WebViewMessage::LoadUrl(url, headers) => {
        if let Some(webview) = get_webview(activity_id) {
          let url = self.env.new_string(url)?;
          load_url(&mut self.env, webview.as_obj(), &url, headers, false)?;
        }
      }
      WebViewMessage::ClearAllBrowsingData => {
        if let Some(webview) = get_webview(activity_id) {
          self
            .env
            .call_method(webview, "clearAllBrowsingData", "()V", &[])?;
        }
      }
      WebViewMessage::LoadHtml(html) => {
        if let Some(webview) = get_webview(activity_id) {
          let html = self.env.new_string(html)?;
          load_html(&mut self.env, webview.as_obj(), &html)?;
        }
      }
      WebViewMessage::Reload => {
        if let Some(webview) = get_webview(activity_id) {
          reload(&mut self.env, webview.as_obj())?;
        }
      }
      WebViewMessage::GoForward => {
        if let Some(webview) = get_webview(activity_id) {
          go_forward(&mut self.env, webview.as_obj())?;
        }
      }
      WebViewMessage::GoBack => {
        if let Some(webview) = get_webview(activity_id) {
          go_back(&mut self.env, webview.as_obj())?;
        }
      }
      WebViewMessage::CanGoForward(tx) => {
        if let Some(webview) = get_webview(activity_id) {
          let can = can_go_forward(&mut self.env, webview.as_obj())?;
          reply(&tx, can, "can-go-forward");
        }
      }
      WebViewMessage::CanGoBack(tx) => {
        if let Some(webview) = get_webview(activity_id) {
          let can = can_go_back(&mut self.env, webview.as_obj())?;
          reply(&tx, can, "can-go-back");
        }
      }
      WebViewMessage::GetCookies(tx, url) => {
        if let Some(webview) = get_webview(activity_id) {
          let url = self.env.new_string(url)?;
          let cookies = self
            .env
            .call_method(
              webview,
              "getCookies",
              "(Ljava/lang/String;)Ljava/lang/String;",
              &[(&url).into()],
            )
            .and_then(|v| v.l())
            .and_then(|s| {
              let s = JString::from(s);
              self
                .env
                .get_string(&s)
                .map(|v| v.to_string_lossy().to_string())
            })
            .unwrap_or_default();

          reply(
            &tx,
            cookies
              .split("; ")
              .flat_map(|c| cookie::Cookie::parse(c.to_string()))
              .collect(),
            "cookies",
          );
        }
      }
      WebViewMessage::OnDestroy {
        activity_id,
        webview_id,
        is_changing_configurations,
      } => {
        // keep our webview references (callbacks etc) alive if the activity is going to be recreated due to configuration changes
        // e.g. rotation, multi-window mode change, etc
        if !is_changing_configurations {
          super::destroy_webview(activity_id, &webview_id);
          remove_activity_proxy(activity_id);
        }
      }
    }
    Ok(())
  }
}

fn load_url<'a>(
  env: &mut JNIEnv<'a>,
  webview: &JObject<'a>,
  url: &JString<'a>,
  headers: Option<http::HeaderMap>,
  main_thread: bool,
) -> JniResult<()> {
  let function = if main_thread {
    "loadUrlMainThread"
  } else {
    "loadUrl"
  };
  if let Some(headers) = headers {
    let obj = env.new_object("java/util/HashMap", "()V", &[])?;
    let headers_map = {
      let headers_map = JMap::from_env(env, &obj)?;
      for (name, value) in headers.iter() {
        let key = env.new_string(name)?;
        let value = env.new_string(value.to_str().unwrap_or_default())?;
        headers_map.put(env, &key, &value)?;
      }
      headers_map
    };
    env.call_method(
      webview,
      function,
      "(Ljava/lang/String;Ljava/util/Map;)V",
      &[url.into(), (&headers_map).into()],
    )?;
  } else {
    env.call_method(webview, function, "(Ljava/lang/String;)V", &[url.into()])?;
  }
  Ok(())
}

fn load_html<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>, html: &JString<'a>) -> JniResult<()> {
  env.call_method(
    webview,
    "loadHTMLMainThread",
    "(Ljava/lang/String;)V",
    &[html.into()],
  )?;
  Ok(())
}

fn reload<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<()> {
  env.call_method(webview, "reload", "()V", &[])?;
  Ok(())
}

fn go_forward<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<()> {
  env.call_method(webview, "goForward", "()V", &[])?;
  Ok(())
}

fn go_back<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<()> {
  env.call_method(webview, "goBack", "()V", &[])?;
  Ok(())
}

fn can_go_forward<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<bool> {
  Ok(env.call_method(webview, "canGoForward", "()Z", &[])?.z()?)
}

fn can_go_back<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<bool> {
  Ok(env.call_method(webview, "canGoBack", "()Z", &[])?.z()?)
}

fn set_background_color<'a>(
  env: &mut JNIEnv<'a>,
  webview: &JObject<'a>,
  (r, g, b, a): RGBA,
) -> JniResult<()> {
  let color = (a as i32) << 24 | (r as i32) << 16 | (g as i32) << 8 | (b as i32);
  env.call_method(webview, "setBackgroundColor", "(I)V", &[color.into()])?;
  Ok(())
}

pub(crate) enum WebViewMessage {
  CreateWebView(CreateWebViewAttributes),
  Eval(String, Option<EvalCallback>),
  SetBackgroundColor(RGBA),
  GetWebViewVersion(Sender<Result<String, Error>>),
  GetUrl(Sender<String>),
  GetCookies(Sender<Vec<cookie::Cookie<'static>>>, String),
  Jni(Box<dyn FnOnce(&mut JNIEnv, &JObject, &JObject) + Send>),
  LoadUrl(String, Option<http::HeaderMap>),
  LoadHtml(String),
  Reload,
  GoForward,
  GoBack,
  CanGoForward(Sender<bool>),
  CanGoBack(Sender<bool>),
  ClearAllBrowsingData,
  OnDestroy {
    activity_id: ActivityId,
    webview_id: WebviewId,
    is_changing_configurations: bool,
  },
}

#[derive(Clone)]
pub(crate) struct CreateWebViewAttributes {
  pub id: String,
  pub url: Option<String>,
  pub html: Option<String>,
  #[cfg(any(debug_assertions, feature = "devtools"))]
  pub devtools: bool,
  pub transparent: bool,
  pub background_color: Option<RGBA>,
  pub headers: Option<http::HeaderMap>,
  pub autoplay: bool,
  pub on_webview_created:
    Option<Arc<dyn Fn(super::Context) -> JniResult<()> + Send + Sync + 'static>>,
  pub user_agent: Option<String>,
  pub initialization_scripts: Vec<InitializationScript>,
  pub javascript_disabled: bool,
}

// SAFETY: only use this when you are sure the span will be dropped on the same thread it was entered
#[cfg(feature = "tracing")]
struct SendEnteredSpan(tracing::span::EnteredSpan);

#[cfg(feature = "tracing")]
unsafe impl Send for SendEnteredSpan {}

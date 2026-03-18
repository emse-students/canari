# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!

# Copyright 2020-2023 Tauri Programme within The Commons Conservancy
# SPDX-License-Identifier: Apache-2.0
# SPDX-License-Identifier: MIT

-keep class fr.emse.canari.* {
  native <methods>;
}

-keep class fr.emse.canari.WryActivity {
  public <init>(...);

  void setWebView(fr.emse.canari.RustWebView);
  java.lang.Class getAppClass(...);
  java.lang.String getVersion();
}

-keep class fr.emse.canari.Ipc {
  public <init>(...);

  @android.webkit.JavascriptInterface public <methods>;
}

-keep class fr.emse.canari.RustWebView {
  public <init>(...);

  void loadUrlMainThread(...);
  void loadHTMLMainThread(...);
  void evalScript(...);
}

-keep class fr.emse.canari.RustWebChromeClient,fr.emse.canari.RustWebViewClient {
  public <init>(...);
}

package com.prdoring.museamo;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(MuseamoPlugin.class);
        super.onCreate(state);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (getBridge() == null) { finish(); return; }
                var webView = getBridge().getWebView();
                var insets = ViewCompat.getRootWindowInsets(webView);
                if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                    WindowCompat.getInsetsController(getWindow(), webView).hide(WindowInsetsCompat.Type.ime());
                    return;
                }
                webView.evaluateJavascript("!window.dispatchEvent(new Event('museamoBack', {cancelable:true}))", handled -> {
                    if (!"true".equals(handled)) finish();
                });
            }
        });
    }
}

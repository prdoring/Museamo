package com.prdoring.museamo;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(MuseamoPlugin.class);
        super.onCreate(state);
    }
}

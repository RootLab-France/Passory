package fr.rootlab.passory;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin local : presse-papier marqué sensible (audit M7).
        registerPlugin(SensitiveClipboardPlugin.class);
        super.onCreate(savedInstanceState);
        // Coffre ouvert : ni capture d'écran, ni enregistrement vidéo, ni vignette
        // dans la liste des applications récentes.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE,
                             WindowManager.LayoutParams.FLAG_SECURE);
    }
}

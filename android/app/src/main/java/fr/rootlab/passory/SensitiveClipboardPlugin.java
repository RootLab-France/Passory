package fr.rootlab.passory;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Presse-papier « sensible » (audit M7) : le texte copié est marqué
 * android.content.extra.IS_SENSITIVE, ce qui le masque dans l'aperçu système
 * (Android 13+) et dans les claviers qui respectent ce marqueur (historique).
 *
 * L'effacement est programmé ici, côté natif : depuis Android 10, une appli en
 * arrière-plan ne peut plus LIRE le presse-papier, donc une comparaison faite
 * en JavaScript échouerait toujours. Aucune méthode de lecture n'est exposée.
 */
@CapacitorPlugin(name = "SensitiveClipboard")
public class SensitiveClipboardPlugin extends Plugin {

    // Valeur de ClipDescription.EXTRA_IS_SENSITIVE (API 33), ignorée avant.
    private static final String EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable clearTask = this::clearNow;

    private ClipboardManager manager() {
        return (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    @PluginMethod
    public void write(PluginCall call) {
        final String text = call.getString("string");
        final Integer clearAfter = call.getInt("clearAfterSeconds", 0);
        if (text == null) {
            call.reject("string requis");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            try {
                ClipData clip = ClipData.newPlainText("Passory", text);
                PersistableBundle extras = new PersistableBundle();
                extras.putBoolean(EXTRA_IS_SENSITIVE, true);
                clip.getDescription().setExtras(extras);
                manager().setPrimaryClip(clip);
                handler.removeCallbacks(clearTask);
                if (clearAfter != null && clearAfter > 0) {
                    handler.postDelayed(clearTask, clearAfter * 1000L);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Copie impossible", e);
            }
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            handler.removeCallbacks(clearTask);
            clearNow();
            call.resolve();
        });
    }

    private void clearNow() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                manager().clearPrimaryClip();
            } else {
                manager().setPrimaryClip(ClipData.newPlainText("", ""));
            }
        } catch (Exception ignored) { }
    }
}

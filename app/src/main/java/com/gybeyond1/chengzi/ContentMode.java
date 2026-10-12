package com.huangguo.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

final class ContentMode {
    static final String PUBLIC = "hongguo", PRIVATE = "huangguo";
    private static ContentMode instance;
    private final SharedPreferences preferences;
    private volatile String active = PUBLIC;

    private ContentMode(Context context) { preferences = context.getSharedPreferences("content-access", Context.MODE_PRIVATE); }
    static synchronized ContentMode get(Context context) {
        if (instance == null) instance = new ContentMode(context.getApplicationContext());
        return instance;
    }
    String active() { return active; }
    void startPublic() { active = PUBLIC; }
    boolean unlocked() { return preferences.getBoolean("privateUnlocked", false); }
    boolean adultConfirmed() { return preferences.getBoolean("adultConfirmed", false); }
    void confirmAdult() { preferences.edit().putBoolean("adultConfirmed", true).apply(); }
    synchronized JSONObject enterPrivate(String password) throws Exception {
        if (!unlocked()) {
            if (!"ssgnb".equals(password)) throw new IllegalArgumentException("密码不正确");
            preferences.edit().putBoolean("privateUnlocked", true).apply();
        }
        if (adultConfirmed()) active = PRIVATE;
        return status();
    }
    synchronized JSONObject finishPrivateEntry() throws Exception {
        if (!unlocked()) throw new IllegalStateException("请先验证密码");
        confirmAdult(); active = PRIVATE;
        return status();
    }
    void require(String source) {
        if (!PUBLIC.equals(source) && !PRIVATE.equals(source)) throw new IllegalArgumentException("无效内容来源");
        if (!source.equals(active) || PRIVATE.equals(source) && (!unlocked() || !adultConfirmed()))
            throw new IllegalStateException("内容已切换，请重新打开");
    }
    JSONObject status() throws Exception {
        return new JSONObject().put("source", active).put("unlocked", unlocked())
                .put("needsAgeConfirmation", unlocked() && !adultConfirmed());
    }
}

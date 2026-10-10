package com.huangguo.mobile;

import android.content.Context;
import org.json.JSONObject;

final class DualContentRepository {
    private final String source;
    private final ContentMode mode;
    private final SiteRepository huangguo;
    private final HongguoRepository hongguo;

    DualContentRepository(Context context) {
        this(context, ContentMode.get(context).active(), HotUpdateManager.get(context).currentSite());
    }
    DualContentRepository(Context context, String source, SiteProfile profile) {
        this.source = source; mode = ContentMode.get(context);
        huangguo = new SiteRepository(context, profile);
        hongguo = new HongguoRepository();
    }
    private boolean privateMode() { mode.require(source); return ContentMode.PRIVATE.equals(source); }
    JSONObject home() throws Exception { return privateMode() ? huangguo.home() : hongguo.home(); }
    JSONObject category(String id, int page) throws Exception { return privateMode() ? huangguo.category(id, page) : hongguo.category(id, page); }
    JSONObject recommend(int page, boolean newest) throws Exception { return privateMode() ? huangguo.recommend(page, newest) : hongguo.recommend(page, newest); }
    JSONObject search(String term) throws Exception { return privateMode() ? huangguo.search(term) : hongguo.search(term); }
    JSONObject detail(String id) throws Exception { return privateMode() ? huangguo.detail(id) : hongguo.detail(id); }
    JSONObject episode(String id, int number) throws Exception { return privateMode() ? huangguo.episode(id, number) : hongguo.episode(id, number); }
    String coverData(String url) throws Exception { return privateMode() ? huangguo.coverData(url) : hongguo.coverData(url); }
    JSONObject tags() throws Exception {
        if (!privateMode()) throw new IllegalStateException("当前来源提供短剧与漫剧分类");
        return huangguo.tags();
    }
    JSONObject tagListing(String slug, int page) throws Exception {
        if (!privateMode()) throw new IllegalStateException("当前来源不支持标签筛选");
        return huangguo.tagListing(slug, page);
    }
    void clearCovers() { if (privateMode()) huangguo.clearCovers(); }
}

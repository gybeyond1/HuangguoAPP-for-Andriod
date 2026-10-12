package com.huangguo.mobile;

import com.hongguotv.core.ContentRepository;
import com.hongguotv.core.Signer;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Public website search covers both supported content kinds in one request. */
final class HongguoSearch {
    private final OkHttpClient http;
    HongguoSearch(OkHttpClient http) { this.http = http; }
    JSONObject search(String keyword) throws Exception { return search(keyword, false); }
    JSONObject search(String keyword, boolean sequelLookup) throws Exception {
        keyword = keyword.trim();
        if (keyword.isEmpty()) return new JSONObject().put("items", new JSONArray()).put("nextPage", JSONObject.NULL);
        if (keyword.length() > 80) throw new IllegalArgumentException("搜索词过长");
        Request request = new Request.Builder().url("https://hongguoduanju.com/search/" + Signer.Companion.encode(keyword))
                .header("User-Agent", "Mozilla/5.0").build();
        try (Response response = http.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("搜索暂时无法连接，请重试");
            JSONObject loader = ContentRepository.Companion.extractRouter(response.body().string()).getJSONObject("loaderData");
            for (java.util.Iterator<String> keys = loader.keys(); keys.hasNext();) {
                JSONObject section = loader.optJSONObject(keys.next());
                if (section != null && section.has("searchList")) return parse(section, keyword, sequelLookup);
            }
            throw new IOException("搜索页面数据结构已变化");
        }
    }
    private static String normalize(String text) { return text.replaceAll("\\s+", "").toLowerCase(Locale.ROOT); }
    static JSONObject parse(JSONObject section, String keyword) throws Exception { return parse(section, keyword, false); }
    private static String normalized(String value, boolean sequelLookup) {
        return sequelLookup ? normalize(value).replaceAll("[\\p{P}\\p{Z}]", "") : normalize(value);
    }
    private static JSONObject parse(JSONObject section, String keyword, boolean sequelLookup) throws Exception {
        if (!section.optBoolean("isSuccess", true)) throw new IOException("搜索服务暂不可用，请重试");
        JSONArray rows = section.getJSONArray("searchList"), items = new JSONArray();
        Set<String> ids = new HashSet<>();
        String query = normalized(keyword, sequelLookup);
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i), video = row == null ? null : row.optJSONObject("video_data");
            if (video == null) continue;
            String id = video.optString("series_id"), title = video.optString("series_title", row.optString("name"));
            String genre = video.optString("genre");
            String type = "203".equals(genre) ? "short" : "205".equals(genre) ? "comic" : "";
            // The website may append unrelated recommendations; never present them as matches.
            if (type.isEmpty() || !id.matches("[0-9]{1,30}") || !normalized(title, sequelLookup).contains(query) || !ids.add(id)) continue;
            JSONArray tags = new JSONArray(), categories = video.optJSONArray("category_list");
            if (categories != null) for (int j = 0; j < categories.length(); j++) {
                JSONObject category = categories.optJSONObject(j);
                if (category != null && !category.optString("name").isEmpty()) tags.put(category.optString("name"));
            }
            items.put(new JSONObject().put("id", id).put("title", title).put("cover", video.optString("series_cover"))
                    .put("description", video.optString("series_intro")).put("episodeLabel", video.optString("episode_right_text"))
                    .put("category", type).put("score", "").put("tags", tags));
        }
        return new JSONObject().put("items", items).put("nextPage", JSONObject.NULL);
    }
}

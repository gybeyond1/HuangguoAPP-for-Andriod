package com.huangguo.mobile;

import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import com.hongguotv.core.RemoteVideo;
import com.hongguotv.core.StreamInfo;
import okhttp3.OkHttpClient;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class HongguoPlayback {
    private static final OkHttpClient HTTP = new OkHttpClient();
    private static final Map<String, StreamInfo> STREAMS = new LinkedHashMap<String, StreamInfo>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, StreamInfo> entry) { return size() > 48; }
    };
    static synchronized void register(StreamInfo info) { STREAMS.put(info.getUrl(), info); }
    private static synchronized StreamInfo info(String url) { return STREAMS.get(url); }
    static DataSource.Factory factory() { return Source::new; }

    private static final class Source extends BaseDataSource {
        private RemoteVideo video;
        private Uri uri;
        private long position, remaining;
        private byte[] buffer = new byte[0];
        private int offset;
        private boolean opened;
        Source() { super(true); }
        @Override public long open(DataSpec spec) throws IOException {
            transferInitializing(spec); uri = spec.uri;
            StreamInfo info = info(uri.toString());
            if (info == null) throw new IOException("播放地址已失效，请重新选集");
            try {
                video = new RemoteVideo(HTTP, info).prepare();
                position = spec.position;
                if (position > video.getTotal()) throw new IOException("读取位置超出视频长度");
                remaining = spec.length == C.LENGTH_UNSET ? video.getTotal() - position : Math.min(spec.length, video.getTotal() - position);
                buffer = new byte[0]; offset = 0; opened = true; transferStarted(spec);
                return remaining;
            } catch (RuntimeException error) { close(); throw new IOException("视频索引读取失败", error); }
            catch (IOException error) { close(); throw error; }
        }
        @Override public int read(byte[] target, int targetOffset, int length) throws IOException {
            if (length == 0) return 0;
            if (remaining == 0) return C.RESULT_END_OF_INPUT;
            try {
                if (offset >= buffer.length) { buffer = video.read(position, (int)Math.min(512 * 1024, remaining)); offset = 0; }
                if (buffer.length == 0) throw new IOException("视频分段意外结束");
                int count = (int)Math.min(Math.min(length, buffer.length - offset), remaining);
                System.arraycopy(buffer, offset, target, targetOffset, count);
                offset += count; position += count; remaining -= count; bytesTransferred(count);
                return count;
            } catch (RuntimeException error) { throw new IOException("视频分段处理失败", error); }
        }
        @Override public Uri getUri() { return uri; }
        @Override public void close() {
            if (video != null) video.close();
            video = null; uri = null; buffer = new byte[0];
            if (opened) { opened = false; transferEnded(); }
        }
    }
}

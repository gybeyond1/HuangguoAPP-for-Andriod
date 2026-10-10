# 橙子短剧 Android 0.3.2

基于原黄果 Android 0.3.0 合入经过手机测试的红果双模式版。包名 com.huangguo.mobile 与原黄果一致，正式签名沿用原证书，可覆盖升级；桌面应用名称改为橙子短剧，图标使用用户提供的橙子播放图。

默认红果内容；设置页连续点击版本号五次进入黄果，首次密码 ssgnb，成年确认后进入。本机记住解锁资格，重启默认红果。评论和弹幕已移除。栏目预测返回、推荐轮播、播放收藏和选集面板外点击关闭等改动保留。

## 数据

黄果继续使用原 huangguo-data，因此原版数据无需搬动；云端继续使用 UserLibrary。红果使用 dual-data-hongguo 与 DualUserLibrary，云查询同时限定 owner、source。原测试包的红果进度通过用户手机上一次性 FileProvider 授权迁入红果分区，旧黄果分区不参与迁移。测试包数据不会嵌入任何公开资源或安装包。

## 更新与签名

热更新继续使用 https://github.com/MrSsg/HuangguoAPP-HotUpdates ，本次资源 r5（2026.10.10.5）。双模式客户端只接受 contentModeVersion=1 的资源，旧黄果界面包被拒绝，坏包仍保留自动回退。最低 APK versionCode=36，避免老客户端加载双模式 UI。

HTML/CSS/JS 与主题支持热更新；Java/Kotlin 原生播放和红果接口需更新 APK。原 APK 更新仓库为 https://github.com/MrSsg/HuangguoAPP-for-Andriod 。

运行 scripts/build-release.ps1 -Offline 生成正式签名包。原版 RSA 正式证书 SHA-256：24e7af1f425dbbedb9b3cf7649f6c3e3f86dc0af759893508cb6f3b58d4f115f。热更新采用原 EC 签名；私钥和口令均不进入仓库。

## 构建与许可

需要 Android SDK 37、JDK、Android Studio Kotlin 编译器；scripts/build-hongguo-core.py 构建 Kotlin 核心。来源固定于 N3urda/hongguoTV 提交 eea73e6a45569a2cbbb9440f7cd5290c459b0b70。Android 派生应用按 GPL-3.0-only 提供，见 LICENSE 与 third_party/hongguo/NOTICE.md。

## 0.3.2 桌面图标白底

自适应桌面图标背景改为纯白 #FFFFFF，橙子前景保持原样。沿用原正式签名，versionCode=37。此项为 APK 原生资源更新，热更新资源 r5 不变。

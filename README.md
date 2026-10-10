# 橙子短剧 Android 0.3.5

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

## 目录整理

原红果双模式版的验证记录、数据隔离检查和合并备份迁入 verification；新增界面检查脚本及截图迁入 qa；旧测试 APK 放在 outputs/legacy-dual-mode。旧源码差异和重复的 Windows/热更新基线差异保存在 archives/dual-mode-history，避免覆盖当前正式版本。独立红果双模式版目录已删除。浏览器缓存、Gradle 构建缓存等生成物不放入活跃源码；完整旧目录已移入同一归档区的“完整旧目录备份”，随后删除空的旧根目录。

## 0.3.3 搜索聚焦与发布命名

搜索输入框聚焦时去掉黄色矩形轮廓，其余输入框与按钮的键盘聚焦提示保留。对应资源包 r6。正式安装包使用 ChengZi-Android-v版本号-release.apk，更新器和构建脚本同步切换到橙子拼音。0.3.2 及更早 APK 校验旧文件名，因此本次过渡需直接覆盖安装新包；0.3.3 起继续走原仓库自动更新。

## 0.3.4 红果大类标签

首页沿用黄果全部类型入口与横向常用类型按钮，类型页按短剧/漫剧分组，当前官网返回24/8个大类。仅提供大类，黄果原细标签功能保留。大类 slug 包含 short:/comic: 命名空间，避免同名类型串用；列表采用官网当前分类路由，保留分页下滑、去重、失败重试与返回页面状态。

生产分类解析/取数代码在电脑上通过实测，确认悬疑第二页24条作品与第一页不同、漫剧玄幻列表正常。真实页面与模拟原生桥的10项界面检查通过，截图在 qa/public-types-results；这不代替用户真机播放验证。资源包r7最低版本39，避免旧客户端出现不支持的标签入口。

本版拒绝早于内置界面的资源 r6 及以前，启动时可直接使用新版内置标签页；APK升级后立即检查热更新，不受上一版本五分钟检查间隔影响。

## 0.3.5 搜索修复与账号缓存优先

旧搜索先取短剧再取漫剧，漫剧非JSON响应导致整次搜索报错。现改用已验证的统一官网搜索读取两类结果，根据返回genre字段区分短剧/漫剧，不用标题猜类型；仅把剧名匹配项作为结果，剔除网站追加的无关推荐。

账号资料及本地头像先从Parse本地用户和按用户保存的图片读取，不进行网络请求，也不等待AccountService的云同步锁。后台再刷新资料和头像，失败保留本地显示；重复资料不重绘页面，刷新保留滚动位置，密码输入中的表单不被重建。头像缓存以原子替换方式写入。

资源r8最低版本40；APK内置界面资源下限同为r8。签名、数据分区、ChengZi发布命名保持。

# MultiPass WebDAV Sync

按 URL 规则处理 HTTP 和 HTTPS 网站的 HTTP Basic 认证，提供加密的本地保险库及可选的加密 WebDAV 同步。

这是基于 [MultiPass for HTTP Basic Authentication](https://github.com/krtek4/MultiPass) 的非官方 fork，发布者为 **xiongmx**。上游项目不是本 fork 的发布者；保留上游 WTFPL v2 署名与许可信息。

[English](README.md) · [隐私政策](https://xiongmx.github.io/multipass-webdav-sync/privacy-policy.html)

## 使用方式

1. 创建保险库，并妥善记住密码；忘记后没有恢复后门。
2. 为受信任的网站添加 URL 匹配规则及 HTTP Basic 用户名和密码。普通 HTTP 下凭据不会加密传输；请优先使用 HTTPS。
3. 每次重启浏览器后解锁保险库。网站发出匹配的源站 Basic 认证挑战时，扩展会按该网站使用的 HTTP 或 HTTPS 协议提供对应凭据。
4. 如需 WebDAV 同步，在每台设备上分别授权，并填写你自己的 HTTPS WebDAV 文件地址和账号。服务端需要支持 GET、PUT、条件请求及强 ETag。

站点规则可匹配 HTTP 和 HTTPS。扩展拒绝代理认证及非 Basic 认证挑战，不读取网页正文或表单内容。

## 保险库与同步

1.1.2 版本使用 AES-GCM-256，配合随机 16 字节 salt 和 12 字节 IV。保险库密码先经 SHA-256 处理，再作为 PBKDF2-HMAC-SHA-256 的输入，迭代 600,000 次。原始保险库密码不保存，也不会发送给 WebDAV 服务。口令派生的根材料仅保留于受信任扩展上下文的会话存储中；重启浏览器后保险库会锁定。

本地凭据规则、WebDAV 账号资料、临时值、备份、同步元数据、JSON 导出及 WebDAV 同步文件均由扩展加密。WebDAV 服务仍会收到其自身账号的授权信息，并可观察端点、请求时间和大小及 ETag 等元数据。ETag 和哈希用于检测变化与冲突，不是加密，也不能阻止恶意回滚。

发生冲突、基线缺失或不一致、ETag 弱或缺失、远端删除等安全检查失败时，同步会停止，而不是按最新时间戳静默覆盖。浏览器定时任务为尽力执行，可能晚于设置的周期。

## 重要限制

- 锁定保险库会停止新的凭据响应和同步尝试，但不能撤回已发出的凭据或写入、清理浏览器 HTTP 认证缓存，或撤销服务端会话。
- 创建保险库时会把旧的本地明文数据迁入加密存储，但无法保证安全擦除浏览器、设备或系统备份中的旧字节。现有远端明文文件不会自动读取或覆盖；迁移和清理需要用户主动操作。
- 撤销 WebDAV 授权会停止定时同步，并清除本地 WebDAV 账号、同步元数据及备份，不会删除远端文件或已下载、导出的副本。
- 本扩展未经过独立安全审计。自动化测试不等于安全认证，也不保证兼容所有服务端或浏览器。

## 平台状态

当前主要安装包面向 Chromium Manifest V3。尚无 Edge Android Stable 的真实设备验证，**不宣称支持 Android**；桌面浏览器的响应式截图不能证明移动端兼容性。Firefox 和 Firefox for Android 构建属于实验性版本，需要单独验证。暂不支持 iOS Safari。

## 开发

```sh
npm ci
npm test
npm run build
npm run dist
npm run test:packages
```

协议集成测试需要安装 Python 依赖：

```sh
python3 -m pip install -r requirements-webdav-e2e.txt
npm run test:webdav-e2e
```

集成测试适配器仅把固定的合成 HTTPS localhost 地址映射到临时 HTTP 回环测试服务，不随扩展打包，不构成产品的 HTTP 例外，也不验证 TLS 握手。

## 隐私、支持与许可

扩展没有分析、广告、遥测、开发者自建数据收集端点或浏览器账号同步服务。数据处理、控制方式和限制详见[隐私政策](https://xiongmx.github.io/multipass-webdav-sync/privacy-policy.html)。

支持及隐私联系邮箱：[multipass@xiongmx.com](mailto:multipass@xiongmx.com)。

采用 [WTFPL v2](LICENSE) 许可；原始上游作者为 Gilles Crettenand。

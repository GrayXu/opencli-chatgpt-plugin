# OpenCLI 1.8.2 小红书搜索兼容补丁

仅当小红书搜索接口返回笔记、但页面没有渲染搜索卡片时使用。补丁让 `xiaohongshu/search` 优先读取页面卡片；卡片为空时，从本次页面请求的搜索响应中读取笔记。MCP 网关本身仍通过 OpenCLI 的命令目录发现和调用工具。

将 OpenCLI 1.8.2 自带的 `clis/xiaohongshu/search.js` 复制到 `~/.opencli/clis/xiaohongshu/search.js`，再从本仓库根目录应用 [补丁](opencli-1.8.2-xiaohongshu-search.patch)：

```bash
patch -p1 -d "$HOME/.opencli" < ops/opencli-1.8.2-xiaohongshu-search.patch
```

本地覆盖只针对搜索命令。OpenCLI 更新后应重新验证并移除不再需要的覆盖，否则它会继续优先于新版本内置适配器。

# 归档判断参考（v5）

本参考已由阶段文件夹模型覆盖。当前真实实现与完整字段说明见仓库根目录的 `CLASSIFICATION_CORE_LOGIC.md`。

当前流程：

```text
抽取 documentType 和事实
→ 判断 businessStage
→ 一一映射为 folderId
→ 人工确认 folderId 与 archiveTitle
→ 服务端解析 folderPath 并归档
```

`documentType` 只帮助理解证据，不再生成“表决票、公司章程、决策文件、其他材料”等目录。阶段不明时转人工，不从全局细分类列表猜测位置。

API 分类结果使用 `targetFolder`，Agent 使用 `selectedFolder`；旧 `categoryId`、`categoryName`、`selectedCategory` 和关键词叶子分类接口已移除。

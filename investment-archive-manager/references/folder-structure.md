# 文件夹结构参考（v5）

本参考已由阶段文件夹模型覆盖。完整字段说明见仓库根目录的 `CLASSIFICATION_CORE_LOGIC.md`。

系统只定义八个最终归档文件夹：

```text
投资项目档案/
├── 基金投资及投资执行/
│   ├── 立项前/
│   ├── 项目立项/
│   ├── 尽职调查/
│   ├── 投资决策/
│   └── 投资实施/
├── 投后管理/
└── 项目退出/
    ├── 退出决策/
    └── 退出执行/
```

`ArchiveFolder` 只包含 `folderId`、`name`、`folderPath`、`businessStage` 和 `isSystemFolder`。旧 `FileTemplate`、`FlatFileCategory` 和细分类关键词表已删除。

用户自建子文件夹只用于人工组织，不进入自动分类候选。

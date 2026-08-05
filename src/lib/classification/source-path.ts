/**
 * 文件路径在系统内部一律保留完整值（用于去重、比对、定位归档记录），
 * 但**任何进入模型提示词的地方只能出现文件名**。
 *
 * 原因：用户按文件夹上传时，前端传的是 webkitRelativePath，形如
 * `君柔档案/投资决策/财务资料/xxx.pdf`。这个路径里的目录名往往就是人工归档的
 * 结果，也就是评测时的标准答案。把它给模型看，模型不需要推理就能答对，
 * 准确率会虚高，且上线后遇到平铺上传立刻失真。
 */

/** 取路径末段的文件名。已经是文件名时原样返回。 */
export function leafName(sourcePath: string): string {
  return sourcePath.split(/[/\\]/).pop() || sourcePath;
}

/**
 * ZIP 包内的目录结构。
 *
 * 下载出来的压缩包必须和网页上看到的归档树长得一样——人在界面上按阶段、按子文件夹
 * 整理过一遍，解压后如果被拍平成一堆文件，那次整理就白做了。
 *
 * 三种下载入口共用这里的算法：整个项目、单个文件夹、跨层级勾选。区别只在于"包的根
 * 目录是哪一层"，所以统一成一件事：算出一个基准路径，把它**上面**的层级全部砍掉，
 * 基准路径本身留作包的根目录，它下面的层级原样保留。
 */

export interface ZipSourceFile {
  id: string;
  archivedName: string;
  /** 归档路径，第一段是项目名。 */
  folderPath: string[];
}

/** ZIP entry 名里不能出现的字符，以及跨平台解压容易出问题的字符。 */
function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[/\\:*?"<>|]/g, "-").trim();
  // 全是非法字符或空白的段落不能变成空字符串，否则 entry 路径里会出现 "//"。
  return cleaned.length > 0 ? cleaned : "未命名";
}

/** 若干条路径的最长公共前缀。 */
export function longestCommonPrefix(paths: string[][]): string[] {
  if (paths.length === 0) return [];
  let prefix = [...paths[0]];
  for (const path of paths.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < path.length && prefix[i] === path[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

function startsWith(path: string[], prefix: string[]): boolean {
  return (
    path.length >= prefix.length &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

/**
 * 给每个文件算出它在 ZIP 里的完整 entry 路径。
 *
 * @param basePath 指定包的根目录对应哪一段归档路径。下载单个文件夹时传它——不传就靠
 *   公共前缀猜，而"只含一个子文件夹的文件夹"会被猜深一层，把用户点的那层弄丢。
 *   如果有文件不在 basePath 之下（勾选跨了分支），basePath 会被忽略，退回自动推断。
 * @param rootLabel 归档路径的第一段是固定的"投资项目档案"，八个项目下载出来的压缩包会
 *   长得一模一样。当包的根目录正好是这一段时，把它换成项目名。只在这种情况下生效：
 *   下载某个子文件夹时根目录是那个文件夹自己，不该被改名。
 */
export function buildZipEntryPaths(
  files: ZipSourceFile[],
  options: { basePath?: string[]; rootLabel?: string } = {}
): Map<string, string> {
  const entries = new Map<string, string>();
  if (files.length === 0) return entries;

  const folderPaths = files.map(file => file.folderPath);
  const requestedBase = options.basePath;
  const base =
    requestedBase && requestedBase.length > 0 &&
    folderPaths.every(path => startsWith(path, requestedBase))
      ? requestedBase
      : longestCommonPrefix(folderPaths);

  // 基准路径的最后一段保留下来当包的根目录，它之上的层级砍掉。
  const stripCount = Math.max(0, base.length - 1);

  // 同一目录下重名的 entry 会被解压工具互相覆盖，加序号区分。归档时已经去过重，
  // 这里只是兜底：跨文件夹勾选后砍掉前缀，本来分开的两个文件可能撞到同一层。
  const usedPaths = new Set<string>();

  for (const file of files) {
    const segments = file.folderPath.slice(stripCount).map(sanitizeSegment);
    // 根目录还是归档路径的第一段（"投资项目档案"）时才换名，换成项目名。
    if (stripCount === 0 && options.rootLabel && segments.length > 0) {
      segments[0] = sanitizeSegment(options.rootLabel);
    }
    const fileName = sanitizeSegment(file.archivedName);
    let entryPath = [...segments, fileName].join("/");

    if (usedPaths.has(entryPath)) {
      const dotIndex = fileName.lastIndexOf(".");
      const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
      const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
      let suffix = 2;
      while (usedPaths.has(entryPath)) {
        entryPath = [...segments, `${stem}(${suffix})${extension}`].join("/");
        suffix++;
      }
    }

    usedPaths.add(entryPath);
    entries.set(file.id, entryPath);
  }

  return entries;
}

/** ZIP 文件本身的名字。 */
export function buildZipFileName(label: string): string {
  const safeLabel = sanitizeSegment(label);
  return `${safeLabel}-${new Date().toISOString().slice(0, 10)}.zip`;
}

/**
 * 归档子路径：八大阶段文件夹之下，用户自己的目录层级。
 *
 * 系统只定义八个业务阶段文件夹，再往下的结构**完全来自用户**——他上传时怎么装的
 * 文件夹，归档后就怎么放。代码不认识"存货明细表""银行对账单"是什么意思，也不该
 * 认识；它只负责把用户已经做好的整理原样搬过去。
 *
 * 这里只做清洗，不做解释：把路径拆成一段段，剔掉会跑出目标目录的写法，限制长度和
 * 层数。任何"这个目录名意味着什么"的判断都不在这个文件里。
 */

/** 子路径最多几层。防的是恶意深度和误传整块磁盘，不是业务约束。 */
export const MAX_SUB_PATH_DEPTH = 8;
/** 单段目录名最大长度，与归档文件名的限制保持一致。 */
export const MAX_SEGMENT_LENGTH = 100;

/**
 * 会让路径跳出目标目录的段。`..` 最危险，`.` 无意义，Windows 保留字符会让
 * 后续拼接出的对象键无法访问。
 */
function isUnsafeSegment(segment: string): boolean {
  if (segment === '.' || segment === '..') return true;
  if (/[<>:"|?*]/.test(segment)) return true;
  // 控制字符会让拼出来的对象键无法访问。空格和连字符必须放行——
  // 「国创中山基金投资文件V4_清洁版_2026.06」「佰特微-投后」这类目录名到处都是。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(segment)) return true;
  return false;
}

/**
 * 把任意来源的子路径清洗成可安全拼接的段数组。
 *
 * 接受字符串（`a/b/c`）或已经拆好的数组。空、超深、含危险字符的段一律丢弃，
 * 而不是报错——上传一整个文件夹时混进一两个怪名字很常见，为此让整批失败不划算。
 */
export function sanitizeSubPath(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[/\\]/)
      : [];

  const segments: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const segment = item.trim();
    if (!segment) continue;
    if (isUnsafeSegment(segment)) continue;
    segments.push(segment.slice(0, MAX_SEGMENT_LENGTH));
    if (segments.length >= MAX_SUB_PATH_DEPTH) break;
  }
  return segments;
}

/**
 * 从上传时的相对路径里取出「顶层条目名」和「它下面的剩余层级」。
 *
 * 判断只发生在顶层：用户拖进来的根目录之下，每一个直接子项（文件或文件夹）各自
 * 判一个阶段，再往下的结构原样保留、不做任何判断。
 *
 * 例：拖进 `佰特微档案/`，其中一份文件的相对路径是
 * `佰特微档案/投资决策/1、天士力FA财务尽调资料2025.7/7、银行对账单/招行2025年06月.pdf`
 *   → topLevelName = `投资决策`（要判阶段的那个文件夹）
 *   → innerPath    = [`1、天士力FA财务尽调资料2025.7`, `7、银行对账单`]（原样保留）
 *   → isTopLevelFile = false
 *
 * 而 `佰特微档案/尽调报告.pdf`
 *   → topLevelName = `尽调报告.pdf`，innerPath = []，isTopLevelFile = true
 *   → 顶层散文件，走现有的完整链路
 */
export interface SourceLocation {
  /** 顶层条目的名字。文件夹名或文件名。 */
  topLevelName: string;
  /** 顶层条目之下的剩余目录层级，不含文件名本身。 */
  innerPath: string[];
  /** 顶层条目本身就是一份文件（没有装在文件夹里）。 */
  isTopLevelFile: boolean;
}

export function parseSourceLocation(sourcePath: string): SourceLocation {
  const segments = sourcePath
    .split(/[/\\]/)
    .map(segment => segment.trim())
    .filter(Boolean);

  // 只有文件名，说明不是拖文件夹进来的（多选文件或单份上传）。
  if (segments.length <= 1) {
    return {
      topLevelName: segments[0] ?? sourcePath,
      innerPath: [],
      isTopLevelFile: true,
    };
  }

  // 第一段是用户拖进来的那个根目录名，它本身不参与判断——判断从它的下一层开始。
  const [, topLevelName, ...rest] = segments;
  if (!topLevelName) {
    return { topLevelName: segments[0], innerPath: [], isTopLevelFile: true };
  }

  // rest 的最后一段是文件名，去掉；剩下的才是要保留的目录层级。
  const innerPath = rest.slice(0, -1);
  return {
    topLevelName,
    innerPath: sanitizeSubPath(innerPath),
    // rest 为空表示这一段就是文件本身，即顶层散文件。
    isTopLevelFile: rest.length === 0,
  };
}

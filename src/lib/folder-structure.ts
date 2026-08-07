/**
 * 投资项目归档文件夹结构。
 *
 * 系统只定义业务阶段文件夹，不再把文档类型建模为目录叶节点。
 * 用户可以在阶段文件夹下自行创建子文件夹；自动分类默认只选择阶段根目录。
 */

export type ArchiveBusinessStage =
  | 'pre_initiation'
  | 'initiation'
  | 'due_diligence'
  | 'investment_decision'
  | 'investment_execution'
  | 'post_investment'
  | 'exit_decision'
  | 'exit_execution';

export interface FolderNode {
  id: string;
  name: string;
  description?: string;
  businessStage?: ArchiveBusinessStage;
  children?: FolderNode[];
}

export interface ArchiveFolder {
  folderId: string;
  name: string;
  folderPath: string[];
  /**
   * null 表示这是分组层（如"投资项目档案""基金投资及投资执行"），不属于任何业务阶段。
   *
   * 允许把文件直接放在这种层里，代价是**它们游离在分析体系之外**：没有阶段就不进
   * 项目时间线、不进冲突复核、数值比对也看不见它们。界面上必须把这一点说明白，
   * 否则用户会以为系统在盯着这些文件。
   */
  businessStage: ArchiveBusinessStage | null;
  description?: string;
  isSystemFolder: true;
}

/** 归属某个业务阶段的目录。阶段选择器、命名规范映射只认这一种。 */
export interface ArchiveStageFolder extends ArchiveFolder {
  businessStage: ArchiveBusinessStage;
}

export const FOLDER_STRUCTURE: FolderNode = {
  id: 'root',
  name: '投资项目档案',
  description: '投资项目档案管理根目录',
  children: [
    {
      id: 'investment',
      name: '基金投资及投资执行',
      children: [
        {
          id: 'pre-project',
          name: '立项前',
          businessStage: 'pre_initiation',
        },
        {
          id: 'project-initiation',
          name: '项目立项',
          businessStage: 'initiation',
        },
        {
          id: 'due-diligence',
          name: '尽职调查',
          businessStage: 'due_diligence',
        },
        {
          id: 'investment-decision',
          name: '投资决策',
          businessStage: 'investment_decision',
        },
        {
          id: 'investment-implementation',
          name: '投资实施',
          businessStage: 'investment_execution',
        },
      ],
    },
    {
      id: 'post-investment',
      name: '投后管理',
      businessStage: 'post_investment',
    },
    {
      id: 'exit',
      name: '项目退出',
      children: [
        {
          id: 'exit-decision',
          name: '退出决策',
          businessStage: 'exit_decision',
        },
        {
          id: 'exit-implementation',
          name: '退出执行',
          businessStage: 'exit_execution',
        },
      ],
    },
  ],
};

/** 摊平成可归档目录列表。分组层也在内，businessStage 为 null。 */
export function flattenArchiveFolders(
  node: FolderNode,
  path: string[] = []
): ArchiveFolder[] {
  const currentPath = [...path, node.name];
  const folders: ArchiveFolder[] = [
    {
      folderId: node.id,
      name: node.name,
      folderPath: currentPath,
      businessStage: node.businessStage ?? null,
      description: node.description,
      isSystemFolder: true,
    },
  ];

  for (const child of node.children ?? []) {
    folders.push(...flattenArchiveFolders(child, currentPath));
  }
  return folders;
}

/** 全部可归档目录，含分组层和根目录。归档接口按这份校验目标是否合法。 */
export const ALL_ARCHIVE_FOLDERS = flattenArchiveFolders(FOLDER_STRUCTURE);

/** 只含八个业务阶段。凡是"选一个阶段"的地方都用这份，分组层不该出现在阶段选择里。 */
export const SYSTEM_ARCHIVE_FOLDERS: ArchiveStageFolder[] =
  ALL_ARCHIVE_FOLDERS.filter(
    (folder): folder is ArchiveStageFolder => folder.businessStage !== null
  );

export function getArchiveFolder(folderId: string): ArchiveFolder | null {
  return (
    ALL_ARCHIVE_FOLDERS.find(folder => folder.folderId === folderId) ?? null
  );
}

/**
 * 一条完整路径落在哪个目录下，以及该目录之下还剩几层。
 *
 * 必须**最长前缀优先**：加入分组层之后，根目录"投资项目档案"是所有路径的前缀，
 * 用 find 取第一个匹配的话，随便选哪一层都会解析成根目录。
 */
export function resolveArchiveFolder(
  fullPath: string[]
): { folder: ArchiveFolder; subPath: string[] } | null {
  const matched = ALL_ARCHIVE_FOLDERS.filter(
    candidate =>
      candidate.folderPath.length <= fullPath.length &&
      candidate.folderPath.every((segment, index) => fullPath[index] === segment)
  ).sort((left, right) => right.folderPath.length - left.folderPath.length);

  const folder = matched[0];
  if (!folder) return null;
  return { folder, subPath: fullPath.slice(folder.folderPath.length) };
}

export function getFolderForBusinessStage(
  stage: ArchiveBusinessStage
): ArchiveStageFolder {
  const folder = SYSTEM_ARCHIVE_FOLDERS.find(
    candidate => candidate.businessStage === stage
  );
  if (!folder) throw new Error(`业务阶段 ${stage} 缺少系统归档文件夹`);
  return folder;
}

export function getFolderBusinessStage(
  folderId: string
): ArchiveBusinessStage | null {
  return getArchiveFolder(folderId)?.businessStage ?? null;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
}

export interface ArchivedFile {
  id: string;
  originalName: string;
  archivedName: string;
  projectId: string;
  projectName: string;
  folderId: string;
  folderPath: string[];
  fileSize: number;
  mimeType: string;
  archivedAt: string;
  confidence: number;
  reasoning: string;
}

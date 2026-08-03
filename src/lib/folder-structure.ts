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
  businessStage: ArchiveBusinessStage;
  description?: string;
  isSystemFolder: true;
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

export function flattenArchiveFolders(
  node: FolderNode,
  path: string[] = []
): ArchiveFolder[] {
  const currentPath = [...path, node.name];
  const folders: ArchiveFolder[] = node.businessStage
    ? [
        {
          folderId: node.id,
          name: node.name,
          folderPath: currentPath,
          businessStage: node.businessStage,
          description: node.description,
          isSystemFolder: true,
        },
      ]
    : [];

  for (const child of node.children ?? []) {
    folders.push(...flattenArchiveFolders(child, currentPath));
  }
  return folders;
}

export const SYSTEM_ARCHIVE_FOLDERS = flattenArchiveFolders(FOLDER_STRUCTURE);

export function getArchiveFolder(folderId: string): ArchiveFolder | null {
  return (
    SYSTEM_ARCHIVE_FOLDERS.find(folder => folder.folderId === folderId) ?? null
  );
}

export function getFolderForBusinessStage(
  stage: ArchiveBusinessStage
): ArchiveFolder {
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

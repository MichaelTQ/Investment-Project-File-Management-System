/**
 * 文件存储工具
 * 负责文件保存、自动命名、归档管理
 */

import fs from 'fs';
import path from 'path';
import type { Project, ArchivedFile } from './folder-structure';

// 存储根目录
const STORAGE_ROOT = process.env.COZE_WORKSPACE_PATH 
  ? path.join(process.env.COZE_WORKSPACE_PATH, 'storage', 'archives')
  : path.join('/tmp', 'investment-archives');

// 项目元数据文件
const PROJECTS_FILE = path.join(STORAGE_ROOT, 'projects.json');
const FILES_INDEX_FILE = path.join(STORAGE_ROOT, 'files-index.json');

// 确保存储目录存在
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// 初始化存储
export function initStorage(): void {
  ensureDir(STORAGE_ROOT);
  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
  if (!fs.existsSync(FILES_INDEX_FILE)) {
    fs.writeFileSync(FILES_INDEX_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
}

// 读取项目列表
export function getProjects(): Project[] {
  initStorage();
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// 保存项目列表
function saveProjects(projects: Project[]): void {
  initStorage();
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8');
}

// 创建项目
export function createProject(name: string, description?: string): Project {
  const projects = getProjects();
  const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  
  const project: Project = {
    id,
    name,
    description: description || '',
    createdAt: now,
    updatedAt: now,
    fileCount: 0
  };
  
  projects.push(project);
  saveProjects(projects);
  
  // 创建项目文件夹
  const projectDir = path.join(STORAGE_ROOT, id);
  ensureDir(projectDir);
  
  return project;
}

// 删除项目
export function deleteProject(id: string): boolean {
  const projects = getProjects();
  const index = projects.findIndex(p => p.id === id);
  if (index === -1) return false;
  
  projects.splice(index, 1);
  saveProjects(projects);
  
  // 删除项目文件夹
  const projectDir = path.join(STORAGE_ROOT, id);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  
  // 删除文件索引中该项目的记录
  const files = getArchivedFiles();
  const filtered = files.filter(f => f.projectId !== id);
  saveArchivedFiles(filtered);
  
  return true;
}

// 更新项目文件计数
export function updateProjectFileCount(projectId: string): void {
  const projects = getProjects();
  const project = projects.find(p => p.id === projectId);
  if (project) {
    const files = getArchivedFiles();
    project.fileCount = files.filter(f => f.projectId === projectId).length;
    project.updatedAt = new Date().toISOString();
    saveProjects(projects);
  }
}

// 读取归档文件索引
export function getArchivedFiles(): ArchivedFile[] {
  initStorage();
  try {
    const data = fs.readFileSync(FILES_INDEX_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// 保存归档文件索引
function saveArchivedFiles(files: ArchivedFile[]): void {
  initStorage();
  fs.writeFileSync(FILES_INDEX_FILE, JSON.stringify(files, null, 2), 'utf-8');
}

/**
 * 自动生成归档文件名
 * 规则：{文件类型}-{项目名称}-{日期}.{扩展名}
 */
export function generateArchivedName(
  originalName: string,
  categoryName: string,
  projectName: string
): string {
  const ext = originalName.split('.').pop() || '';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // 清理文件名中的特殊字符
  const safeCategory = categoryName.replace(/[\/\\:*?"<>|]/g, '-');
  const safeProject = projectName.replace(/[\/\\:*?"<>|]/g, '-');
  return `${safeCategory}-${safeProject}-${date}.${ext}`;
}

/**
 * 归档文件：保存到项目文件夹并记录索引
 */
export function archiveFile(
  fileBuffer: Buffer,
  originalName: string,
  projectId: string,
  projectName: string,
  categoryId: string,
  categoryName: string,
  folderPath: string[],
  mimeType: string,
  confidence: number,
  reasoning: string
): ArchivedFile {
  initStorage();
  
  const archivedName = generateArchivedName(originalName, categoryName, projectName);
  
  // 构建归档路径：storage/archives/{projectId}/{folderPath...}/{archivedName}
  const relativeDir = folderPath.slice(1).join('/'); // 去掉"投资项目档案"根目录
  const targetDir = path.join(STORAGE_ROOT, projectId, relativeDir);
  ensureDir(targetDir);
  
  const targetPath = path.join(targetDir, archivedName);
  fs.writeFileSync(targetPath, fileBuffer);
  
  // 创建归档记录
  const archivedFile: ArchivedFile = {
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    originalName,
    archivedName,
    projectId,
    projectName,
    categoryId,
    categoryName,
    folderPath,
    fileSize: fileBuffer.length,
    mimeType,
    archivedAt: new Date().toISOString(),
    confidence,
    reasoning
  };
  
  // 更新索引
  const files = getArchivedFiles();
  files.push(archivedFile);
  saveArchivedFiles(files);
  
  // 更新项目文件计数
  updateProjectFileCount(projectId);
  
  return archivedFile;
}

// 获取项目的归档文件列表
export function getProjectFiles(projectId: string): ArchivedFile[] {
  const files = getArchivedFiles();
  return files.filter(f => f.projectId === projectId);
}

// 获取所有归档文件
export function getAllArchivedFiles(): ArchivedFile[] {
  return getArchivedFiles();
}

// 获取文件的实际存储路径
export function getFilePath(archivedFile: ArchivedFile): string {
  const relativeDir = archivedFile.folderPath.slice(1).join('/');
  return path.join(STORAGE_ROOT, archivedFile.projectId, relativeDir, archivedFile.archivedName);
}

// 删除归档文件
export function deleteArchivedFile(fileId: string): boolean {
  const files = getArchivedFiles();
  const file = files.find(f => f.id === fileId);
  if (!file) return false;
  
  // 删除物理文件
  const filePath = getFilePath(file);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  
  // 更新索引
  const filtered = files.filter(f => f.id !== fileId);
  saveArchivedFiles(filtered);
  
  // 更新项目文件计数
  updateProjectFileCount(file.projectId);
  
  return true;
}

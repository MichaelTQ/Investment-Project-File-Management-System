/**
 * 统一存储层：Supabase（元数据）+ S3 对象存储（文件实体）
 * 实现跨设备同步：文件存 S3，索引存 Supabase
 */
import { S3Storage } from "coze-coding-dev-sdk";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============ 类型定义 ============

export interface Project {
  id: string;
  name: string;
  description: string;
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
  categoryId: string;
  categoryName: string;
  folderPath: string[];
  fileSize: number;
  mimeType: string;
  archivedAt: string;
  confidence: number;
  reasoning: string;
  storageKey: string; // S3 对象存储 key
}

export interface FolderTreeNode {
  name: string;
  path: string;
  type: "folder" | "file";
  children?: FolderTreeNode[];
  file?: ArchivedFile;
}

// ============ S3 存储初始化 ============

function getS3Storage(): S3Storage {
  return new S3Storage({
    endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
    accessKey: "",
    secretKey: "",
    bucketName: process.env.COZE_BUCKET_NAME,
    region: "cn-beijing",
  });
}

// ============ Supabase 客户端 ============

function getDb(): SupabaseClient {
  return getSupabaseClient();
}

// ============ 项目管理 ============

export async function createProject(
  name: string,
  description: string
): Promise<Project> {
  const db = getDb();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("projects")
    .insert({
      name,
      description,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw new Error(`创建项目失败: ${error.message}`);

  return {
    id: data.id,
    name: data.name,
    description: data.description ?? "",
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    fileCount: 0,
  };
}

export async function listProjects(): Promise<Project[]> {
  const db = getDb();
  const { data, error } = await db
    .from("projects")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`获取项目列表失败: ${error.message}`);

  // 获取每个项目的文件数量
  const { data: fileCounts, error: countError } = await db
    .from("archived_files")
    .select("project_id");

  if (countError) throw new Error(`获取文件计数失败: ${countError.message}`);

  const countMap = new Map<string, number>();
  for (const f of fileCounts ?? []) {
    countMap.set(f.project_id, (countMap.get(f.project_id) ?? 0) + 1);
  }

  return (data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    fileCount: countMap.get(p.id) ?? 0,
  }));
}

export async function getProject(id: string): Promise<Project | null> {
  const db = getDb();
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) return null;

  return {
    id: data.id,
    name: data.name,
    description: data.description ?? "",
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    fileCount: 0,
  };
}

export async function deleteProject(id: string): Promise<void> {
  const db = getDb();

  // 先删除该项目下的所有归档文件（从 S3 和数据库）
  const { data: files } = await db
    .from("archived_files")
    .select("id, storage_key")
    .eq("project_id", id);

  if (files) {
    const s3 = getS3Storage();
    for (const f of files) {
      if (f.storage_key) {
        try {
          await s3.deleteFile({ fileKey: f.storage_key });
        } catch {
          // 忽略 S3 删除失败
        }
      }
    }
  }

  // 删除数据库记录
  await db.from("archived_files").delete().eq("project_id", id);
  await db.from("projects").delete().eq("id", id);
}

// ============ 文件名去重 ============

async function dedupeArchivedName(
  baseName: string,
  projectId: string,
  folderPath: string[],
  excludeFileId?: string
): Promise<string> {
  const db = getDb();
  const { data } = await db
    .from("archived_files")
    .select("id, archived_name")
    .eq("project_id", projectId)
    .eq("folder_path", folderPath);

  if (!data || data.length === 0) return baseName;

  const existingNames = new Set(
    data
      .filter((f: { id: string }) => f.id !== excludeFileId)
      .map((f: { archived_name: string }) => f.archived_name)
  );
  if (!existingNames.has(baseName)) return baseName;

  const dotIdx = baseName.lastIndexOf(".");
  const prefix = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;
  const ext = dotIdx > 0 ? baseName.slice(dotIdx) : "";

  let counter = 1;
  while (existingNames.has(`${prefix}-${counter}${ext}`)) {
    counter++;
  }
  return `${prefix}-${counter}${ext}`;
}

function sanitizeArchiveTitle(
  title: string | undefined,
  fallback: string,
  extension: string
): string {
  let sanitized = (title ?? "").trim();

  if (extension && sanitized.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    sanitized = sanitized.slice(0, -(extension.length + 1));
  }

  sanitized = sanitized
    .replace(/[/\\:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 50)
    .trim();

  return sanitized || fallback;
}

// ============ 文件归档 ============

export async function archiveFile(params: {
  fileBuffer: Buffer;
  originalName: string;
  mimeType: string;
  projectId: string;
  projectName: string;
  categoryId: string;
  categoryName: string;
  folderPath: string[];
  confidence: number;
  reasoning: string;
  archiveTitle?: string;
}): Promise<ArchivedFile> {
  const db = getDb();
  const s3 = getS3Storage();

  // 1. 生成归档文件名（去重）
  const dotIndex = params.originalName.lastIndexOf(".");
  const ext = dotIndex > 0 ? params.originalName.slice(dotIndex + 1) : "";
  const extensionSuffix = ext ? `.${ext}` : "";
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const archiveTitle = sanitizeArchiveTitle(
    params.archiveTitle,
    params.categoryName,
    ext
  );
  const baseName = `${archiveTitle}-${params.projectName}-${dateStr}${extensionSuffix}`;
  const archivedName = await dedupeArchivedName(
    baseName,
    params.projectId,
    params.folderPath
  );

  // 2. 上传到 S3 对象存储
  const folderPrefix = params.folderPath.join("/");
  const s3Key = await s3.uploadFile({
    fileContent: params.fileBuffer,
    fileName: `archives/${params.projectId}/${folderPrefix}/${archivedName}`,
    contentType: params.mimeType,
  });

  // 3. 写入 Supabase 数据库
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("archived_files")
    .insert({
      original_name: params.originalName,
      archived_name: archivedName,
      project_id: params.projectId,
      project_name: params.projectName,
      category_id: params.categoryId,
      category_name: params.categoryName,
      folder_path: params.folderPath,
      file_size: params.fileBuffer.length,
      mime_type: params.mimeType,
      archived_at: now,
      confidence: params.confidence,
      reasoning: params.reasoning,
      storage_key: s3Key,
    })
    .select()
    .single();

  if (error) throw new Error(`归档文件失败: ${error.message}`);

  // 4. 更新项目时间
  await db
    .from("projects")
    .update({ updated_at: now })
    .eq("id", params.projectId);

  return {
    id: data.id,
    originalName: data.original_name,
    archivedName: data.archived_name,
    projectId: data.project_id,
    projectName: data.project_name,
    categoryId: data.category_id,
    categoryName: data.category_name,
    folderPath: data.folder_path,
    fileSize: data.file_size,
    mimeType: data.mime_type,
    archivedAt: data.archived_at,
    confidence: data.confidence,
    reasoning: data.reasoning ?? "",
    storageKey: data.storage_key,
  };
}

// ============ 文件移动 ============

export async function moveArchivedFile(
  fileId: string,
  target: { categoryId: string; categoryName: string; folderPath: string[] }
): Promise<ArchivedFile | null> {
  const db = getDb();

  // 查找当前文件信息
  const { data: currentFile } = await db
    .from("archived_files")
    .select("archived_name, project_id")
    .eq("id", fileId)
    .single();

  // 检查目标路径下是否存在同名文件，如有则重命名
  const archivedName = currentFile
    ? await dedupeArchivedName(
        currentFile.archived_name,
        currentFile.project_id,
        target.folderPath,
        fileId
      )
    : "";

  const updateData: Record<string, unknown> = {
    category_id: target.categoryId,
    category_name: target.categoryName,
    folder_path: target.folderPath,
  };
  if (archivedName !== currentFile?.archived_name) {
    updateData.archived_name = archivedName;
  }

  const { data, error } = await db
    .from("archived_files")
    .update(updateData)
    .eq("id", fileId)
    .select()
    .single();

  if (error) throw new Error(`移动文件失败: ${error.message}`);
  if (!data) return null;

  return {
    id: data.id,
    originalName: data.original_name,
    archivedName: data.archived_name,
    projectId: data.project_id,
    projectName: data.project_name,
    categoryId: data.category_id,
    categoryName: data.category_name,
    folderPath: data.folder_path,
    fileSize: data.file_size,
    mimeType: data.mime_type,
    archivedAt: data.archived_at,
    confidence: data.confidence,
    reasoning: data.reasoning ?? "",
    storageKey: data.storage_key,
  };
}

// ============ 文件查询 ============

export async function listArchivedFiles(
  projectId?: string
): Promise<ArchivedFile[]> {
  const db = getDb();
  let query = db
    .from("archived_files")
    .select("*")
    .order("archived_at", { ascending: false });

  if (projectId) {
    query = query.eq("project_id", projectId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`获取归档文件失败: ${error.message}`);

  return (data ?? []).map(mapArchivedFile);
}

export async function getArchivedFile(id: string): Promise<ArchivedFile | null> {
  const db = getDb();
  const { data, error } = await db
    .from("archived_files")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) return null;
  return mapArchivedFile(data);
}

export async function deleteArchivedFile(id: string): Promise<void> {
  const db = getDb();

  // 先获取文件信息
  const { data: file } = await db
    .from("archived_files")
    .select("storage_key")
    .eq("id", id)
    .single();

  // 从 S3 删除
  if (file?.storage_key) {
    const s3 = getS3Storage();
    try {
      await s3.deleteFile({ fileKey: file.storage_key });
    } catch {
      // 忽略
    }
  }

  // 从数据库删除
  await db.from("archived_files").delete().eq("id", id);
}

// ============ 文件下载 ============

export async function getFileDownloadUrl(id: string): Promise<{
  url: string;
  fileName: string;
} | null> {
  const db = getDb();
  const { data, error } = await db
    .from("archived_files")
    .select("storage_key, archived_name")
    .eq("id", id)
    .single();

  if (error || !data || !data.storage_key) return null;

  const s3 = getS3Storage();
  const url = await s3.generatePresignedUrl({
    key: data.storage_key,
    expireTime: 86400, // 24 小时
  });

  return { url, fileName: data.archived_name };
}

export async function getFileDownloadStream(
  id: string
): Promise<{ buffer: Buffer; fileName: string; mimeType: string } | null> {
  const db = getDb();
  const { data, error } = await db
    .from("archived_files")
    .select("storage_key, archived_name, mime_type")
    .eq("id", id)
    .single();

  if (error || !data || !data.storage_key) return null;

  const s3 = getS3Storage();
  const buffer = await s3.readFile({ fileKey: data.storage_key });

  return {
    buffer,
    fileName: data.archived_name,
    mimeType: data.mime_type ?? "application/octet-stream",
  };
}

// ============ 一键下载全部（ZIP） ============

export async function getAllFileDownloadStreams(
  projectId: string
): Promise<Array<{ buffer: Buffer; fileName: string; folderPath: string[] }>> {
  const db = getDb();
  const { data, error } = await db
    .from("archived_files")
    .select("*")
    .eq("project_id", projectId);

  if (error) throw new Error(`获取文件列表失败: ${error.message}`);

  const s3 = getS3Storage();
  const results: Array<{
    buffer: Buffer;
    fileName: string;
    folderPath: string[];
  }> = [];

  for (const file of data ?? []) {
    if (!file.storage_key) continue;
    try {
      const buffer = await s3.readFile({ fileKey: file.storage_key });
      results.push({
        buffer,
        fileName: file.archived_name,
        folderPath: file.folder_path ?? [],
      });
    } catch {
      // 跳过无法读取的文件
    }
  }

  return results;
}

// ============ 树形结构 ============

export function buildArchiveTree(files: ArchivedFile[]): FolderTreeNode[] {
  const rootChildren: FolderTreeNode[] = [];

  for (const file of files) {
    const path = file.folderPath;
    let currentChildren = rootChildren;

    for (let i = 0; i < path.length; i++) {
      const segment = path[i];
      const fullPath = path.slice(0, i + 1).join("/");

      // 在当前层级查找或创建文件夹节点
      let node = currentChildren.find(
        (c) => c.type === "folder" && c.name === segment
      ) as FolderTreeNode | undefined;

      if (!node) {
        node = {
          name: segment,
          path: fullPath,
          type: "folder",
          children: [],
        };
        currentChildren.push(node);
      }

      if (i === path.length - 1) {
        // 最后一层，添加文件
        node.children!.push({
          name: file.archivedName,
          path: `${fullPath}/${file.archivedName}`,
          type: "file",
          file,
        });
      } else {
        // 进入下一层
        currentChildren = node.children!;
      }
    }
  }

  return rootChildren;
}

// ============ 工具函数 ============

function mapArchivedFile(data: Record<string, unknown>): ArchivedFile {
  return {
    id: data.id as string,
    originalName: data.original_name as string,
    archivedName: data.archived_name as string,
    projectId: data.project_id as string,
    projectName: data.project_name as string,
    categoryId: data.category_id as string,
    categoryName: data.category_name as string,
    folderPath: (data.folder_path as string[]) ?? [],
    fileSize: data.file_size as number,
    mimeType: data.mime_type as string,
    archivedAt: data.archived_at as string,
    confidence: data.confidence as number,
    reasoning: (data.reasoning as string) ?? "",
    storageKey: data.storage_key as string,
  };
}

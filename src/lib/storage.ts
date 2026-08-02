/**
 * 统一存储层：Supabase（元数据）+ S3 对象存储（文件实体）
 * 实现跨设备同步：文件存 S3，索引存 Supabase
 */
import { S3Storage } from "coze-coding-dev-sdk";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Readable } from "stream";

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
  folderPath?: string[];
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

// ============ 临时上传文件 ============

export async function uploadTemporaryFile(params: {
  stream: Readable;
  fileName: string;
  mimeType: string;
  projectId: string;
}): Promise<string> {
  const s3 = getS3Storage();
  return s3.streamUploadFile({
    stream: params.stream,
    fileName: `uploads/${params.projectId}/${crypto.randomUUID()}-${params.fileName}`,
    contentType: params.mimeType,
  });
}

/** 将 Buffer 上传到 S3 临时目录，返回 storageKey。用于大文件 multipart 上传避免 Base64 膨胀。 */
export async function uploadTempFileFromBuffer(params: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  projectId: string;
}): Promise<string> {
  const s3 = getS3Storage();
  return s3.uploadFile({
    fileContent: params.buffer,
    fileName: `uploads/${params.projectId}/${crypto.randomUUID()}-${params.fileName}`,
    contentType: params.mimeType,
  });
}

export async function uploadTemporaryChunk(params: {
  buffer: Buffer;
  projectId: string;
  uploadId: string;
  chunkIndex: number;
}): Promise<string> {
  return getS3Storage().uploadFile({
    fileContent: params.buffer,
    fileName:
      `upload-chunks/${params.projectId}/${params.uploadId}/` +
      `chunk-${params.chunkIndex}.part`,
    contentType: "application/octet-stream",
  });
}

export async function combineTemporaryChunks(params: {
  chunkKeys: string[];
  fileName: string;
  mimeType: string;
  projectId: string;
}): Promise<string> {
  const s3 = getS3Storage();

  async function* readChunks() {
    for (const key of params.chunkKeys) {
      yield await s3.readFile({ fileKey: key });
    }
  }

  return s3.chunkUploadFile({
    chunks: readChunks(),
    fileName:
      `uploads/${params.projectId}/${crypto.randomUUID()}-${params.fileName}`,
    contentType: params.mimeType,
  });
}

export async function deleteStoredFilesByPrefix(prefix: string): Promise<void> {
  const s3 = getS3Storage();
  let continuationToken: string | undefined;

  do {
    const result = await s3.listFiles({
      prefix,
      maxKeys: 1000,
      continuationToken,
    });
    await Promise.all(
      result.keys.map(key => s3.deleteFile({ fileKey: key }))
    );
    continuationToken = result.isTruncated
      ? result.nextContinuationToken
      : undefined;
  } while (continuationToken);
}

/** 上传应用内部生成的数据对象，并返回实际的 S3 storageKey。 */
export async function writeStoredFile(params: {
  buffer: Buffer;
  storageKey: string;
  mimeType?: string;
}): Promise<string> {
  return getS3Storage().uploadFile({
    fileContent: params.buffer,
    fileName: params.storageKey,
    contentType: params.mimeType ?? "application/octet-stream",
  });
}

/** 列出指定前缀下的全部对象，自动处理 S3 分页。 */
export async function listStoredFilesByPrefix(
  prefix: string
): Promise<string[]> {
  const s3 = getS3Storage();
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await s3.listFiles({
      prefix,
      maxKeys: 1000,
      continuationToken,
    });
    keys.push(...result.keys);
    continuationToken = result.isTruncated
      ? result.nextContinuationToken
      : undefined;
  } while (continuationToken);

  return keys;
}

export async function readStoredFile(storageKey: string): Promise<Buffer> {
  return getS3Storage().readFile({ fileKey: storageKey });
}

export async function getStoredFileUrl(
  storageKey: string,
  expireTime = 3600
): Promise<string> {
  return getS3Storage().generatePresignedUrl({
    key: storageKey,
    expireTime,
  });
}

export async function deleteStoredFile(storageKey: string): Promise<void> {
  await getS3Storage().deleteFile({ fileKey: storageKey });
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
  const aggregateResult = await db
    .from("projects")
    .select("*, archived_files(count)")
    .order("updated_at", { ascending: false });

  if (!aggregateResult.error) {
    return (aggregateResult.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      fileCount: p.archived_files?.[0]?.count ?? 0,
    }));
  }

  // 兼容尚未向 PostgREST 暴露外键关系的既有环境。
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

export async function renameProject(
  id: string,
  newName: string,
  newDescription?: string
): Promise<Project> {
  const db = getDb();
  const name = newName.trim();

  if (!id) throw new Error("缺少项目 ID");
  if (!name) throw new Error("项目名称不能为空");
  if (name.length > 255) throw new Error("项目名称不能超过 255 个字符");

  const { data: current, error: currentError } = await db
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (currentError || !current) throw new Error("项目不存在");

  const description =
    typeof newDescription === "string"
      ? newDescription.trim()
      : current.description ?? "";
  if (description.length > 2000) {
    throw new Error("项目描述不能超过 2000 个字符");
  }

  const { data: otherProjects, error: duplicateError } = await db
    .from("projects")
    .select("id, name")
    .neq("id", id);

  if (duplicateError) {
    throw new Error(`检查项目名称失败: ${duplicateError.message}`);
  }

  const normalizedName = name.toLocaleLowerCase("zh-CN");
  if (
    (otherProjects ?? []).some(
      (project) =>
        String(project.name).trim().toLocaleLowerCase("zh-CN") === normalizedName
    )
  ) {
    throw new Error("已存在同名项目，请使用其他名称");
  }

  const nameChanged = current.name !== name;
  const descriptionChanged = (current.description ?? "") !== description;

  if (!nameChanged && !descriptionChanged) {
    const { count } = await db
      .from("archived_files")
      .select("id", { count: "exact", head: true })
      .eq("project_id", id);

    return {
      id: current.id,
      name: current.name,
      description: current.description ?? "",
      createdAt: current.created_at,
      updatedAt: current.updated_at,
      fileCount: count ?? 0,
    };
  }

  const now = new Date().toISOString();
  const { data: updated, error: projectError } = await db
    .from("projects")
    .update({ name, description, updated_at: now })
    .eq("id", id)
    .select()
    .single();

  if (projectError || !updated) {
    throw new Error(`项目重命名失败: ${projectError?.message ?? "未知错误"}`);
  }

  const { error: filesError } = nameChanged
    ? await db
        .from("archived_files")
        .update({ project_name: name })
        .eq("project_id", id)
    : { error: null };

  if (filesError) {
    // 两张表无法在客户端事务中同时更新；同步失败时尽量恢复原项目名称。
    await db
      .from("projects")
      .update({
        name: current.name,
        description: current.description ?? "",
        updated_at: current.updated_at,
      })
      .eq("id", id);
    throw new Error(`同步归档文件的项目名称失败: ${filesError.message}`);
  }

  const { count } = await db
    .from("archived_files")
    .select("id", { count: "exact", head: true })
    .eq("project_id", id);

  return {
    id: updated.id,
    name: updated.name,
    description: updated.description ?? "",
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
    fileCount: count ?? 0,
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

function sanitizeOriginalArchivedName(
  originalName: string,
  fallback: string
): string {
  const leafName = originalName.split(/[/\\]/).pop()?.trim() || "";
  const sanitized = leafName
    .replace(/[:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 500)
    .trim();

  return sanitized || fallback;
}

async function buildArchivedName(params: {
  originalName: string;
  archiveTitle?: string;
  categoryName: string;
  projectName: string;
  projectId: string;
  folderPath: string[];
}): Promise<string> {
  const dotIndex = params.originalName.lastIndexOf(".");
  const ext = dotIndex > 0 ? params.originalName.slice(dotIndex + 1) : "";
  const extensionSuffix = ext ? `.${ext}` : "";
  const hasConfirmedTitle = Boolean(params.archiveTitle?.trim());

  const baseName = hasConfirmedTitle
    ? `${sanitizeArchiveTitle(
        params.archiveTitle,
        params.categoryName,
        ext
      )}${extensionSuffix}`
    : sanitizeOriginalArchivedName(
        params.originalName,
        `${params.categoryName}${extensionSuffix}`
      );

  return dedupeArchivedName(
    baseName,
    params.projectId,
    params.folderPath
  );
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

  // 1. 关键词分类保留原名；只有提供了确认标题时才执行 LLM 命名。
  const archivedName = await buildArchivedName(params);

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

// 已经上传到 S3 的文件只写入归档索引，不再重复上传文件实体。
export async function archiveStoredFile(params: {
  storageKey: string;
  originalName: string;
  fileSize: number;
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
  const exists = await getS3Storage().fileExists({ fileKey: params.storageKey });
  if (!exists) throw new Error("S3 中的待归档文件不存在，请重新上传");

  const archivedName = await buildArchivedName(params);
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
      file_size: params.fileSize,
      mime_type: params.mimeType,
      archived_at: now,
      confidence: params.confidence,
      reasoning: params.reasoning,
      storage_key: params.storageKey,
    })
    .select()
    .single();

  if (error) throw new Error(`归档文件失败: ${error.message}`);

  await db
    .from("projects")
    .update({ updated_at: now })
    .eq("id", params.projectId);

  return mapArchivedFile(data);
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

// ============ 文件与文件夹重命名 ============

function validateFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("文件夹名称不能为空");
  if (/[/\\:*?"<>|\u0000-\u001F]/.test(trimmed)) {
    throw new Error("文件夹名称不能包含 / \\ : * ? \" < > | 等字符");
  }
  if (trimmed.length > 100) throw new Error("文件夹名称不能超过 100 个字符");
  return trimmed;
}

function pathStartsWith(path: string[], prefix: string[]): boolean {
  return (
    path.length >= prefix.length &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

export async function renameArchivedFile(
  fileId: string,
  newTitle: string
): Promise<ArchivedFile | null> {
  const db = getDb();
  const current = await getArchivedFile(fileId);
  if (!current) return null;

  const dotIndex = current.archivedName.lastIndexOf(".");
  const ext = dotIndex > 0 ? current.archivedName.slice(dotIndex + 1) : "";
  const extensionSuffix = ext ? `.${ext}` : "";
  const sanitizedTitle = sanitizeArchiveTitle(
    newTitle,
    dotIndex > 0
      ? current.archivedName.slice(0, dotIndex)
      : current.archivedName,
    ext
  );
  const archivedName = await dedupeArchivedName(
    `${sanitizedTitle}${extensionSuffix}`,
    current.projectId,
    current.folderPath,
    fileId
  );

  const { data, error } = await db
    .from("archived_files")
    .update({ archived_name: archivedName })
    .eq("id", fileId)
    .select()
    .single();

  if (error) throw new Error(`重命名文件失败: ${error.message}`);
  return data ? mapArchivedFile(data) : null;
}

export async function renameArchivedFolder(params: {
  projectId: string;
  sourcePath: string[];
  newName: string;
}): Promise<number> {
  const db = getDb();
  const newName = validateFolderName(params.newName);
  const sourcePath = params.sourcePath;
  if (sourcePath.length < 2) throw new Error("系统根文件夹不能重命名");
  if (sourcePath[sourcePath.length - 1] === newName) return 0;

  const { data, error } = await db
    .from("archived_files")
    .select("*")
    .eq("project_id", params.projectId);
  if (error) throw new Error(`读取文件夹内容失败: ${error.message}`);

  const rows = data ?? [];
  const parentPath = sourcePath.slice(0, -1);
  const targetRows = rows.filter(row =>
    pathStartsWith(row.folder_path ?? [], sourcePath)
  );
  if (targetRows.length === 0) throw new Error("文件夹不存在或已经为空");

  const siblingExists = rows.some(row => {
    const folderPath: string[] = row.folder_path ?? [];
    return (
      !pathStartsWith(folderPath, sourcePath) &&
      pathStartsWith(folderPath, parentPath) &&
      folderPath[parentPath.length] === newName
    );
  });
  if (siblingExists) throw new Error(`同级目录已存在文件夹「${newName}」`);

  for (const row of targetRows) {
    const oldPath: string[] = row.folder_path;
    const folderPath = [
      ...sourcePath.slice(0, -1),
      newName,
      ...oldPath.slice(sourcePath.length),
    ];
    const updateData: Record<string, unknown> = { folder_path: folderPath };
    if (oldPath.length === sourcePath.length) {
      updateData.category_name = newName;
    }

    const { error: updateError } = await db
      .from("archived_files")
      .update(updateData)
      .eq("id", row.id);
    if (updateError) {
      throw new Error(`重命名文件夹失败: ${updateError.message}`);
    }
  }

  return targetRows.length;
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

export async function deleteArchivedFile(id: string): Promise<{
  archivedFileId: string;
  projectId: string;
  originalName: string;
} | null> {
  const db = getDb();

  // 先获取文件信息
  const { data: file } = await db
    .from("archived_files")
    .select("storage_key, project_id, original_name")
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
  const { error } = await db.from("archived_files").delete().eq("id", id);
  if (error) throw new Error(`删除归档文件失败: ${error.message}`);
  return file
    ? {
        archivedFileId: id,
        projectId: file.project_id,
        originalName: file.original_name,
      }
    : null;
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
          folderPath: path.slice(0, i + 1),
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

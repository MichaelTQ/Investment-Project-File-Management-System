import { getFolderBusinessStage } from '../folder-structure';
import { listArchivedFiles } from '../storage';
import {
  checkArchiveConsistency,
  type ArchiveDocument,
  type ConsistencyFinding,
} from './archive-consistency';
import { getProjectDocumentFacts } from './session-project-memory';

export interface ProjectConsistencyReport {
  /** 参与本次校验的文件数。findings 为空但 checkedCount>0 时，表示代码无话可说，不是认可。 */
  checkedCount: number;
  findings: ConsistencyFinding[];
  /** 有事实但还没归档、或归档记录已不存在的文件，本次跳过。 */
  skippedCount: number;
}

/**
 * 对整个项目跑一次归档一致性校验。
 *
 * 关键点：比较的基准是文件**实际归在哪个文件夹**，不是当初 Agent 建议归哪。
 * 用户手动改过归档位置时，必须以用户的选择为准——校验器的职责是发现"现状和
 * 事实矛盾"，而不是维护自己当初的判断。
 *
 * 纯计算，不调模型，不读原始文件，因此可以在每次归档后无条件全量重跑。
 */
export async function checkProjectConsistency(
  projectId: string
): Promise<ProjectConsistencyReport> {
  const [documentFacts, archivedFiles] = await Promise.all([
    getProjectDocumentFacts(projectId),
    listArchivedFiles(projectId),
  ]);

  const archivedById = new Map(archivedFiles.map(file => [file.id, file]));
  const archivedByName = new Map(
    archivedFiles.map(file => [file.originalName, file])
  );

  const documents: ArchiveDocument[] = [];
  let skippedCount = 0;

  for (const document of documentFacts) {
    // 优先用归档记录 ID 关联；早期记录可能没有该字段，退回按原始文件名匹配。
    const leafName = document.sourcePath.split(/[/\\]/).pop() ?? document.sourcePath;
    const archived =
      (document.archivedFileId
        ? archivedById.get(document.archivedFileId)
        : undefined) ?? archivedByName.get(leafName);

    if (!archived) {
      skippedCount += 1;
      continue;
    }

    const currentStage = getFolderBusinessStage(archived.folderId);
    if (!currentStage) {
      skippedCount += 1;
      continue;
    }

    documents.push({
      sourcePath: document.sourcePath,
      facts: document.facts,
      currentStage,
    });
  }

  return {
    checkedCount: documents.length,
    findings: checkArchiveConsistency(documents),
    skippedCount,
  };
}

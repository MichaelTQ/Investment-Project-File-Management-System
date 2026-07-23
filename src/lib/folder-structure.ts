/**
 * 投资项目档案管理文件夹结构定义
 * 基于《国创致远-投资项目档案管理》文档
 * 支持按项目维度组织
 */

export interface FolderNode {
  id: string;
  name: string;
  description?: string;
  children?: FolderNode[];
  files?: FileTemplate[];
}

export interface FileTemplate {
  name: string;
  keywords: string[];
  description?: string;
}

// 完整的文件夹结构定义（文件类型模板，不含项目维度）
export const FOLDER_STRUCTURE: FolderNode = {
  id: 'root',
  name: '投资项目档案',
  description: '投资项目档案管理根目录',
  children: [
    {
      id: 'investment',
      name: '基金投资及投资执行',
      description: '基金投资及投资执行阶段相关档案',
      children: [
        {
          id: 'pre-project',
          name: '立项前',
          description: '立项前阶段文件',
          files: [
            { name: '保密协议', keywords: ['保密', '协议', 'NDA', 'confidential'], description: '项目立项前签署的保密协议' }
          ]
        },
        {
          id: 'project-initiation',
          name: '项目立项',
          description: '项目立项阶段文件',
          files: [
            { name: '立项申请书', keywords: ['立项', '申请', '立项申请'], description: '项目立项申请文件' },
            { name: '立项报告', keywords: ['立项报告', '立项评审'], description: '项目立项评审报告' },
            { name: '商业计划书', keywords: ['商业计划', 'BP', 'business plan', '商业计划书'], description: '拟投项目商业计划书' },
            { name: '立项评审纪要', keywords: ['评审', '纪要', '立项评审纪要'], description: '立项评审会议纪要' }
          ]
        },
        {
          id: 'due-diligence',
          name: '尽职调查',
          description: '尽职调查阶段文件',
          files: [
            { name: '业务尽调报告', keywords: ['业务尽调', '业务尽职', '行业尽调', '业务尽调报告'], description: '业务/行业尽职调查报告' },
            { name: '财务尽调报告', keywords: ['财务尽调', '财务尽职', '财务尽调报告'], description: '财务尽职调查报告' },
            { name: '法律尽调报告', keywords: ['法律尽调', '法务尽调', '法律尽职', '法律尽调报告'], description: '法律尽职调查报告' }
          ]
        },
        {
          id: 'investment-decision',
          name: '投资决策',
          description: '投资决策阶段文件',
          children: [
            {
              id: 'decision-meeting',
              name: '上会材料',
              description: '投资决策上会材料',
              files: [
                { name: '上会申请表', keywords: ['上会', '申请表', '上会申请'], description: '投资决策上会申请表' },
                { name: '营业执照', keywords: ['营业执照', '三证合一', 'business license'], description: '三证合一后的营业执照' },
                { name: '经营许可证', keywords: ['经营许可', '审批', '批文', '特许经营'], description: '特殊行业经营许可审批文件' },
                { name: '贷款资料', keywords: ['贷款', '负债', '担保', '银行'], description: '银行负债相关资料' },
                { name: '公司章程', keywords: ['章程', '工商登记', '公司章程'], description: '项目公司工商登记章程' },
                { name: '纳税报表', keywords: ['纳税', '税务', '纳税报表'], description: '项目公司纳税报表' },
                { name: '土地房产证', keywords: ['土地证', '房产证', '土地房产', '不动产权证'], description: '土地房产相关证明' },
                { name: '汇算清缴报告', keywords: ['汇算清缴', '清缴报告', '近三年'], description: '近三年汇算清缴报告' },
                { name: '审计报告', keywords: ['审计', '审计报告', '近三年'], description: '近三年审计报告' },
                { name: '财务预测', keywords: ['财务预测', '预测报告'], description: '项目公司财务预测' },
                { name: '投资建议书', keywords: ['投资建议', '建议书', '投资建议书'], description: '投资建议书' }
              ]
            },
            {
              id: 'decision-documents',
              name: '决策文件',
              description: '投资决策委员会决策文件',
              files: [
                { name: '表决票', keywords: ['表决', '投票', '表决票', '委员'], description: '所有参会委员签署的表决票' },
                { name: '投委会决议', keywords: ['决议', '投委会', '投资决策', '投委会决议'], description: '投资决策委员会决议' }
              ]
            }
          ]
        },
        {
          id: 'investment-implementation',
          name: '投资实施',
          description: '投资实施阶段文件',
          files: [
            { name: '增资协议', keywords: ['增资协议', '增资', '股权转让', '协议原件'], description: '增资协议/股权转让协议（原件）' },
            { name: '股东协议', keywords: ['股东协议', '投资者权利', '股东协议'], description: '股东协议/投资者权利协议（原件）' },
            { name: '项目公司章程', keywords: ['项目公司章程', '新章程'], description: '项目公司章程' },
            { name: '股东会决议', keywords: ['股东会', '决议', '股东会决议'], description: '项目公司股东会决议' },
            { name: '董事会决议', keywords: ['董事会', '决议', '董事会决议'], description: '项目公司董事会决议' },
            { name: '付款通知函', keywords: ['付款', '通知函', '确认函', '付款通知'], description: '拟投资标的确认函(即付款通知函)' },
            { name: '转账凭证', keywords: ['转账', '凭证', '投资款'], description: '投资款转账凭证' },
            { name: '确权文件', keywords: ['确权', '股东名册', '交割', '出资证明'], description: '股东名册、交割确认函、股东出资证明书' },
            { name: '工商变更档案', keywords: ['工商变更', '变更档案', '工商'], description: '项目公司工商变更档案' }
          ]
        }
      ]
    },
    {
      id: 'post-investment',
      name: '投后管理',
      description: '投后管理阶段相关档案',
      children: [
        {
          id: 'post-investment-report',
          name: '投后管理报告',
          description: '投后管理报告文件',
          files: [
            { name: '半年度投后报告', keywords: ['半年度', '投后报告', '半年度投后', '9月'], description: '半年度投后管理报告（9月15日前出具）' },
            { name: '年度投后报告', keywords: ['年度', '投后报告', '年度投后', '审计后'], description: '年度投后管理报告（被投企业出具审计报告后1个月内出具）' },
            { name: '异常项目月度报告', keywords: ['月度', '异常', '风险', '月度报告'], description: '异常类项目月度报告（出现重大风险投资项目的）' }
          ]
        },
        {
          id: 'field-research',
          name: '实地调研',
          description: '实地调研相关文件',
          files: [
            { name: '访谈记录', keywords: ['访谈', '调研', '访谈记录', '访谈纪要'], description: '实地调研访谈记录' },
            { name: '调研照片', keywords: ['照片', '调研', '实地', '图片'], description: '实地调研照片' }
          ]
        },
        {
          id: 'enterprise-materials',
          name: '更新被投企业材料',
          description: '被投企业信息更新材料',
          files: [
            { name: '企业信息更新', keywords: ['企业信息', '台账', '信息更新', '季度'], description: '被投企业信息、台账信息更新' },
            { name: '系统更新记录', keywords: ['系统', '投资管理系统', '更新记录'], description: '投资管理系统更新记录' }
          ]
        },
        {
          id: 'risk-management',
          name: '投后风险管理',
          description: '投后风险管理相关文件',
          files: [
            { name: '风险事件报告', keywords: ['风险', '事件', '上报', 'T+0'], description: '重大风险事件上报（T+0）' },
            { name: '风险处置方案', keywords: ['风险处置', '处置方案', '风险方案'], description: '风险处置方案' }
          ]
        }
      ]
    },
    {
      id: 'exit',
      name: '项目退出',
      description: '项目退出阶段相关档案',
      children: [
        {
          id: 'exit-decision',
          name: '退出决策',
          description: '退出决策阶段文件',
          children: [
            {
              id: 'exit-meeting',
              name: '上会材料',
              description: '退出决策上会材料',
              files: [
                { name: '退出方案', keywords: ['退出', '方案', '退出方案'], description: '项目退出方案' }
              ]
            },
            {
              id: 'exit-decision-docs',
              name: '决策文件',
              description: '退出决策文件',
              files: [
                { name: '退出表决票', keywords: ['表决', '退出', '表决票'], description: '退出决策表决票' },
                { name: '退出投委会决议', keywords: ['决议', '退出', '投委会'], description: '退出投委会决议' }
              ]
            }
          ]
        },
        {
          id: 'exit-implementation',
          name: '退出执行',
          description: '退出执行阶段文件',
          files: [
            { name: '交易协议', keywords: ['交易', '协议', '交易协议'], description: '退出交易协议' },
            { name: '转账凭证', keywords: ['转账', '凭证', '退出'], description: '退出转账凭证' },
            { name: '档案移交表', keywords: ['档案', '移交', '移交表'], description: '项目全部档案移交表' }
          ]
        }
      ]
    }
  ]
};

// 扁平化的文件分类列表，用于快速匹配
export interface FlatFileCategory {
  folderPath: string[];
  folderId: string;
  fileName: string;
  keywords: string[];
  description?: string;
}

// 将树形结构扁平化为便于搜索的列表
export function flattenFolderStructure(node: FolderNode, path: string[] = []): FlatFileCategory[] {
  const result: FlatFileCategory[] = [];
  const currentPath = [...path, node.name];
  
  if (node.files) {
    for (const file of node.files) {
      result.push({
        folderPath: currentPath,
        folderId: node.id,
        fileName: file.name,
        keywords: file.keywords,
        description: file.description
      });
    }
  }
  
  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenFolderStructure(child, currentPath));
    }
  }
  
  return result;
}

// 获取扁平化的文件分类列表
export const FLAT_FILE_CATEGORIES = flattenFolderStructure(FOLDER_STRUCTURE);

// ============ 项目相关接口 ============

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
}

// 归档文件记录
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
}

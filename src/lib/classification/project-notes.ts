/**
 * 项目备注：唯一一个允许用户把自己的业务口径写进提示词的入口。
 *
 * 系统本身不许凭常识猜"什么文件归哪个阶段"——那类映射只能来自客户提供的归档规范。
 * 但项目负责人自己写下的东西是另一回事：那不是我们的猜测，是需求。所以这段文字
 * 会原样进入判阶段、判文件夹和冲突复核的提示词。
 *
 * 典型用法是写归档习惯，比如"FA 提供的财务尽调底稿随上会材料归入投资决策"——
 * 这种口径规范里没有、模型也猜不出，只有人知道。
 */

/** 备注进提示词的字数上限。太长会挤占其他规则的注意力，也会让每次调用都变贵。 */
export const MAX_PROJECT_NOTES_LENGTH = 500;

export function normalizeProjectNotes(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_PROJECT_NOTES_LENGTH);
}

/**
 * 拼成提示词里的一段。没有备注时返回空串，提示词里不会出现这一节——
 * 空标题比没有标题更容易让模型以为"这里本该有内容但缺失了"。
 *
 * 措辞上要划清一条界线：口径决定"这类文件我们放哪"，事实决定"这份文件是什么"。
 * 前者是用户说了算的，后者不是——否则一句备注就能让模型无视文件里白纸黑字写着的
 * 内容，那比没有备注更危险。
 */
export function describeProjectNotes(notes: string): string {
  const normalized = normalizeProjectNotes(notes);
  if (!normalized) return '';
  return `

【本项目的归档口径（项目负责人填写）】
${normalized}

以上是本项目负责人写下的归档习惯与背景说明。涉及"这一类文件我们习惯放在哪里"时，
以它为准，优先于你的一般判断。但它不能推翻文件自身记载的事实：如果某份文件的内容
明确指向别处，仍按内容判断，并在理由里说明与口径不一致的地方。`;
}

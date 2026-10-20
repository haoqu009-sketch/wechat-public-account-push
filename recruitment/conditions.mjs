// Evidence extraction only: a missing condition is never interpreted as permission.
const clean = value => String(value ?? '').replace(/\b(20)\s*(\d)\s+(\d)(?=\s*(?:年|届))/g, '$1$2$3').replace(/\s+/g, ' ').trim();
// “2027年应届硕士研究生及以上学历毕业生” is a cohort, not a bare notice year.
const graduate = '(?:应届)?(?:(?:本科|硕士|博士)(?:研究生)?(?:及以上)?(?:学历)?|研究生)?(?:毕业生|生)';
const cohortSuffix = `(?:届|年(?:度)?\\s*${graduate})`;
const cohortPattern = new RegExp(`20\\d{2}\\s*${cohortSuffix}`);
const parts = text => clean(text).split(/(?<=[。；;])|(?=\s*[(（][一二三四五六七八九十]+[)）])/).map(clean).filter(Boolean);
const localOnly = /部分岗位|博士(?:后|岗位|岗)|硕士岗位|本科岗位|具体岗位|各岗位|岗位表|详见|例如|比如/;

function sectionText(text, headings) {
  const match = text.match(new RegExp(`(?:${headings})\\s*[:：]?\\s*([\\s\\S]{1,2200}?)(?=(?:[一二三四五六七八九十]{1,3}、)|报名办法|招聘岗位|岗位需求|$)`));
  return match?.[1] || '';
}

export function cohortEvidence(text, year) {
  const value = clean(text), target = `${year}\\s*${cohortSuffix}`;
  const negated = new RegExp(`(?:不(?:接受|接收|招收|招聘|含|包括)?|排除|不面向)\\s*${target}|${target}\\s*(?:不得|不可|不予|不符合|除外)`).test(value);
  const doctorateOnly = new RegExp(`${year}\\s*(?:届|年(?:度)?)\\s*(?:应届)?博士|${target}\\s*(?:的)?博士`).test(value);
  const positive = new RegExp(target).test(value) && !doctorateOnly;
  const any = /届别不限|毕业(?:年份|年度|届别|年限)不限|不限(?:毕业)?(?:年份|届别)|应往届/.test(value);
  const range = [...value.matchAll(/(20\d{2})\s*届\s*(?:及|和)?\s*(以后|之后|以上|以前|之前|以下)/g)]
    .some(match => /以后|之后|以上/.test(match[2]) ? year >= Number(match[1]) : year <= Number(match[1]));
  const between = [...value.matchAll(/(20\d{2})\s*(?:届|年)?\s*[-—~～至到]\s*(20\d{2})\s*(?:届|年)/g)]
    .some(match => year >= Number(match[1]) && year <= Number(match[2]));
  const proofIndex = value.search(new RegExp(target));
  const otherIndex = value.search(cohortPattern);
  const start = Math.max(0, (proofIndex >= 0 ? proofIndex : otherIndex >= 0 ? otherIndex : 0) - 70);
  return { confirmed: !negated && !doctorateOnly && (positive || any || range || between), negated, explicit: cohortPattern.test(value) || any || range || between, quote: value.slice(start, start + 500) };
}

export function commonConditions(page, profile) {
  // pageData supplies table-free text: another job's row must not become a global rule.
  const text = clean(page.commonText ?? page.text), sentences = parts(text);
  const section = sectionText(text, '招聘对象|招聘范围|招考对象|应聘对象|引进对象|引才对象');
  const conditionSection = sectionText(text, '基本条件|聘用条件|应聘条件|招聘条件|报考条件');
  const scopedRules = parts(conditionSection).filter(value => !localOnly.test(value)
    && /应聘(?:人员|者)|报考(?:人员|者)|招聘对象|须为|必须为/.test(value) && cohortEvidence(value, profile.graduationYear).explicit);
  // Conditions override the opening summary. Only an explicit notice-wide subject
  // is inherited; a different job's example/doctoral exception is not permission.
  const intro = text.split(/[一二三四五六七八九十]{1,3}、/)[0];
  const introRule = parts(intro).find(value => !localOnly.test(value) && /面向|招聘对象/.test(value)
    && cohortEvidence(value, profile.graduationYear).explicit);
  const generalCohort = scopedRules.length ? scopedRules.join('；') : section || introRule
    || sentences.find(value => /(?:符合|面向|接受).{0,60}应往届(?:毕业生)?/.test(value) && !localOnly.test(value)) || '';
  const cohort = cohortEvidence(generalCohort, profile.graduationYear);
  if (scopedRules.some(value => !cohortEvidence(value, profile.graduationYear).confirmed)) cohort.confirmed = false;
  // An explicitly single-cohort campus notice is usable; a bare year in a title is not.
  if (!cohort.explicit && /应届(?:生|毕业生)/.test(page.title || '')) {
    const titleRule = cohortEvidence(page.title, profile.graduationYear);
    if (titleRule.confirmed && !/多批|社会招聘|应往届|往届/.test(page.title)) Object.assign(cohort, titleRule);
  }
  const degreeSection = conditionSection;
  const degree = parts(degreeSection).find(value => /硕士|博士|本科/.test(value) && /学历|学位/.test(value) && !/部分岗位|博士后|各岗位|具体岗位|详见|岗位表|优先/.test(value)) || '';
  const application = sentences.find(value => /(?:自|即日|公告发布).{0,25}(?:接受|开始)?报名/.test(value) && /招满即止|额满为止|招满为止/.test(value))
    || sentences.find(value => /招满即止|额满为止|招满为止/.test(value)) || '';
  const certificateClause = sentences.find(value => !localOnly.test(value) && /毕业证|学历证|学历[、及和，\s]*学位/.test(value)
    && /(?:须|应|必须)(?:于|在).{0,35}(?:前|以前)\s*取得/.test(value));
  const certificateDeadline = certificateClause?.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const currentCertificate = sentences.find(value => /报名时|报名前/.test(value) && /(?:须|必须|需).{0,20}(?:提供|取得|提交|持有)/.test(value) && /毕业证|学位证|学历证/.test(value));
  const exclusionText = text.match(/(?:不得|不能|不予)(?:报考|应聘|接收)[\s\S]{0,1200}/)?.[0]
    || sentences.find(value => /不得|不能|不接收/.test(value) && /在读(?:的)?非/.test(value)) || '';
  const studentExclusion = exclusionText.match(/(?:普通高校)?在读(?:的)?非\s*(20\d{2})\s*(?:年|届)毕业生/);
  const registration = sentences.map(value => value.replace(/^(?:[(（][一二三四五六七八九十]+[)）])?\s*报名(?:及|与)(?:网上)?资格审查\s*/, ''))
    .filter(value => /报名|报名表|投递|发送.{0,15}邮箱/.test(value)
    && !/资格审查|资格复审|打印|准考证|笔试|面试|考察|体检/.test(value)
    && /(?:于|自|在|即日起).{0,170}(?:至|到).{0,100}(?:期间|止|报名|投递|发送)/.test(value));
  const additionalEligibility = parts(section).find(value => /具体条件为|引进对象|招聘对象/.test(value)
    && /国家统一招生|未落实(?:过)?工作单位|档案.{0,50}保留/.test(value)) || '';
  return {
    cohort, degree: degree.slice(0, 500), application: application.slice(0, 500),
    certificateDeadline: certificateDeadline ? { date: `${certificateDeadline[1]}-${certificateDeadline[2].padStart(2, '0')}-${certificateDeadline[3].padStart(2, '0')}`, quote: certificateClause.slice(0, 500) } : null,
    currentCertificate: currentCertificate?.slice(0, 500) || '',
    registration, additionalEligibility: additionalEligibility.slice(0, 500),
    studentExclusion: studentExclusion ? { year: Number(studentExclusion[1]), quote: exclusionText.slice(Math.max(0, studentExclusion.index - 65), studentExclusion.index + 100) } : null,
  };
}

export function rowCohortConditions(row, common, year) {
  // “2025至2027届无需提供医师证” is a document exemption, not a
  // graduation-cohort admission rule. Keep it in the row, but don't infer eligibility.
  const scoped = row.split(/[；;]/).filter(value => !(/医师|资格|证书|材料/.test(value) && /无需提供|免于提供|不需提供/.test(value))).join('；');
  const evidence = cohortEvidence(scoped, year);
  // Row-specific exclusions win over general eligibility. Unrestricted general conditions
  // cannot erase a row explicitly restricted to an older cohort.
  return evidence.explicit || evidence.negated ? { ...evidence, scope: '岗位条件' }
    : { ...common.cohort, scope: '公告统一条件' };
}

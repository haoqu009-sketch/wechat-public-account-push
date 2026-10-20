// Evidence extraction only: a missing condition is never interpreted as permission.
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const cohortPattern = /20\d{2}\s*(?:届|年度?\s*(?:应届)?毕业生|年度?\s*应届生)/;
const parts = text => clean(text).split(/(?<=[。；;])|(?=\s*[(（][一二三四五六七八九十]+[)）])/).map(clean).filter(Boolean);

export function cohortEvidence(text, year) {
  const value = clean(text), target = `${year}\\s*(?:届|年度?\\s*(?:应届)?毕业生|年度?\\s*应届生)`;
  const negated = new RegExp(`(?:不(?:接受|接收|招收|招聘|含|包括)?|排除|不面向)\\s*${target}|${target}\\s*(?:不得|不可|不予|不符合|除外)`).test(value);
  const positive = new RegExp(target).test(value) && !new RegExp(`${target}\\s*(?:的)?博士`).test(value);
  const any = /届别不限|毕业(?:年份|年度|届别|年限)不限|不限(?:毕业)?(?:年份|届别)|应往届/.test(value);
  const range = [...value.matchAll(/(20\d{2})\s*届\s*(?:及|和)?\s*(以后|之后|以上|以前|之前|以下)/g)]
    .some(match => /以后|之后|以上/.test(match[2]) ? year >= Number(match[1]) : year <= Number(match[1]));
  const between = [...value.matchAll(/(20\d{2})\s*(?:届|年)?\s*[-—~～至到]\s*(20\d{2})\s*(?:届|年)/g)]
    .some(match => year >= Number(match[1]) && year <= Number(match[2]));
  return { confirmed: !negated && (positive || any || range || between), negated, explicit: cohortPattern.test(value) || any || range || between, quote: value.slice(0, 500) };
}

export function commonConditions(page, profile) {
  // pageData supplies table-free text: another job's row must not become a global rule.
  const text = clean(page.commonText ?? page.text), sentences = parts(text);
  const section = text.match(/(?:招聘对象|招聘范围|招考对象|应聘对象)\s*[:：]?\s*([\s\S]{1,900}?)(?=基本要求|基本条件|招聘条件|招聘岗位|岗位需求|二、|三、|$)/)?.[1] || '';
  const generalCohort = section || sentences.find(value => /(?:符合|面向|接受).{0,60}应往届(?:毕业生)?/.test(value)) || '';
  const cohort = cohortEvidence(generalCohort, profile.graduationYear);
  // An explicitly single-cohort campus notice is usable; a bare year in a title is not.
  if (!cohort.explicit && /应届(?:生|毕业生)/.test(page.title || '')) {
    const titleRule = cohortEvidence(page.title, profile.graduationYear);
    if (titleRule.confirmed && !/多批|社会招聘|应往届|往届/.test(page.title)) Object.assign(cohort, titleRule);
  }
  const degreeSection = text.match(/(?:基本条件|聘用条件|应聘条件)\s*[:：]?\s*([\s\S]{1,1000}?)(?=三、|四、|报名办法|招聘岗位|岗位需求|$)/)?.[1] || '';
  const degree = parts(degreeSection).find(value => /硕士|博士|本科/.test(value) && /学历|学位/.test(value) && !/部分岗位|博士后|各岗位|具体岗位|详见|岗位表|优先/.test(value)) || '';
  const application = sentences.find(value => /(?:自|即日|公告发布).{0,25}(?:接受|开始)?报名/.test(value) && /招满即止|额满为止|招满为止/.test(value))
    || sentences.find(value => /招满即止|额满为止|招满为止/.test(value)) || '';
  const certificateDeadline = text.match(/(?:报考人员|应聘人员|所有人员|考生)?(?:均)?须于\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:前|以前).{0,70}(?:毕业证|学历证)/);
  const currentCertificate = sentences.find(value => /报名时|报名前/.test(value) && /(?:须|必须|需).{0,20}(?:提供|取得|提交|持有)/.test(value) && /毕业证|学位证|学历证/.test(value));
  const studentExclusion = text.match(/普通高校在读非\s*(20\d{2})\s*届毕业生/);
  const registration = sentences.filter(value => /报名|报名表|投递|发送.{0,15}邮箱/.test(value)
    && !/资格审查|资格复审|打印|准考证|笔试|面试|考察|体检/.test(value)
    && /(?:于|自|即日起).{0,170}(?:至|到).{0,100}(?:期间|止|报名|投递|发送)/.test(value));
  return {
    cohort, degree: degree.slice(0, 500), application: application.slice(0, 500),
    certificateDeadline: certificateDeadline ? { date: `${certificateDeadline[1]}-${certificateDeadline[2].padStart(2, '0')}-${certificateDeadline[3].padStart(2, '0')}`, quote: certificateDeadline[0] } : null,
    currentCertificate: currentCertificate?.slice(0, 500) || '',
    registration,
    studentExclusion: studentExclusion ? { year: Number(studentExclusion[1]), quote: text.slice(Math.max(0, studentExclusion.index - 65), studentExclusion.index + 100) } : null,
  };
}

export function rowCohortConditions(row, common, year) {
  const evidence = cohortEvidence(row, year);
  // Row-specific exclusions win over general eligibility. Unrestricted general conditions
  // cannot erase a row explicitly restricted to an older cohort.
  return evidence.explicit || evidence.negated ? { ...evidence, scope: '岗位条件' }
    : { ...common.cohort, scope: '公告统一条件' };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile } from '../profile.mjs';
import { jobFrom } from '../core.mjs';
import { evaluateOfficialJob } from '../verification.mjs';

const base = { graduationYear: 2027, degree: '硕士', specialty: '医学影像学', residencyCompleted: true, physicianQualification: true };
const source = { name: '甲医院', province: '黑龙江', url: 'https://hospital.example/jobs' };
const page = { title: '甲医院2027年应届毕业生招聘公告', url: source.url, published: '2026-10-20', text: '招聘对象：2027年应届毕业生。二、报名安排。自公告发布之日起接受报名，招满即止。' };
const make = text => jobFrom(`岗位名称：放射科医师；学历：硕士；专业：放射影像学；${text}`, page, source, base, 1);
const profile = resolveProfile(base, JSON.stringify({ degreeType: '学硕', birthYear: 2000, specialty: '放射影像学', residencySpecialty: '放射影像学' }));

test('两个专业字段独立覆盖且保留学硕和出生年份，不推断专业代码或学位类型', () => {
  assert.equal(profile.specialty, '放射影像学'); assert.equal(profile.residencySpecialty, '放射影像学');
  assert.equal(profile.degreeType, '学硕'); assert.equal(profile.birthYear, 2000);
  assert.equal(profile.specialtyCode, undefined);
  assert.equal(resolveProfile(base, '{"residencySpecialty":"放射影像学"}').specialty, base.specialty);
  for (const input of [{ specialty: 123 }, { residencySpecialty: '' }, { specialty: '<script>' }, { specialty: '专业\n名称' }, { specialtyCode: '105123' }]) assert.throws(() => resolveProfile(base, JSON.stringify(input)));
});

test('研究生名称明确列入可消除名称疑点，但代码要求和专硕硬限制不能随之消除', () => {
  const result = evaluateOfficialJob(make('其他条件：2027届'), page, profile, '2026-10-21');
  assert.ok(!result.issues.some(issue => /研究生专业.*不能准确对应/.test(issue)));
  const coded = make('其他条件：2027届'); coded.specialtyRequirement = '放射影像学（105123）';
  assert.match(evaluateOfficialJob(coded, page, profile, '2026-10-21').issues.join('；'), /专业代码/);
  const professional = make('学位类型：专业学位硕士；其他条件：2027届');
  assert.equal(evaluateOfficialJob(professional, page, profile, '2026-10-21').state, 'mismatch');
});

test('用户明确更正专硕后替换旧学硕，不以专业名称推断或改写其他个人信息', () => {
  const corrected = resolveProfile(profile, '{"degreeType":"专硕"}');
  assert.equal(corrected.degreeType, '专硕'); assert.equal(corrected.specialty, profile.specialty);
  assert.equal(corrected.residencySpecialty, profile.residencySpecialty); assert.equal(corrected.birthYear, profile.birthYear);
  const professional = evaluateOfficialJob(make('学位类型：专业学位硕士'), page, corrected, '2026-10-21');
  assert.ok(!professional.issues.some(issue => /学位类型.*不符/.test(issue)));
  assert.equal(evaluateOfficialJob(make('学位类型：学术学位硕士'), page, corrected, '2026-10-21').state, 'mismatch');
});

test('规培专业仅精确且明确列名时确认，近义名、对应关系和多选名称继续保留疑点', () => {
  const result = evaluateOfficialJob(make('规培专业：放射影像学'), page, profile, '2026-10-21');
  assert.ok(result.evidence.some(proof => proof.field === 'residencySpecialty'));
  assert.ok(!result.issues.some(issue => /规培要求涉及专业方向/.test(issue)));
  for (const text of ['规培专业：医学影像科', '规培专业须与应聘岗位一致', '规培专业：放射影像学或核医学']) {
    const result = evaluateOfficialJob(make(text), page, profile, '2026-10-21');
    assert.match(result.issues.join('；'), /规培要求涉及专业方向/);
    assert.ok(!result.evidence.some(proof => proof.field === 'residencySpecialty'));
  }
});

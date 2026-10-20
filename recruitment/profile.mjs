// Personal matching inputs stay in protected runtime configuration, not public JSON.
export function resolveProfile(base, encoded) {
  if (!encoded) return { ...base };
  let input;
  try { input = JSON.parse(encoded); } catch { throw new Error('个人核验条件配置无效'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['degreeType', 'birthYear', 'specialty', 'residencySpecialty'].includes(key))) throw new Error('个人核验条件配置无效');
  if (input.degreeType !== undefined && !['学硕', '专硕'].includes(input.degreeType)) throw new Error('个人核验条件配置无效');
  if (input.birthYear !== undefined && (!Number.isInteger(input.birthYear) || input.birthYear < 1950 || input.birthYear > 2010)) throw new Error('个人核验条件配置无效');
  for (const field of ['specialty', 'residencySpecialty']) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string' || !/^[\p{Script=Han}A-Za-z0-9·（）()\- ]{2,80}$/u.test(input[field]) || !input[field].trim()) throw new Error('个人核验条件配置无效');
    input[field] = input[field].trim();
  }
  return { ...base, ...input };
}

/** Fetch wrappers for server/src/routes/admin.js. Admin data is always fetched live. */

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json();
}

export function getSchoolOverview(schoolId) {
  return getJson(`/api/admin/schools/${encodeURIComponent(schoolId)}/overview`);
}

export async function getSchoolClasses(schoolId) {
  const { classes } = await getJson(`/api/admin/schools/${encodeURIComponent(schoolId)}/classes`);
  return classes;
}

export function getClassStudents(classGroupId) {
  return getJson(`/api/admin/classes/${encodeURIComponent(classGroupId)}/students`);
}

export async function getSchoolFlagged(schoolId) {
  const { flagged } = await getJson(`/api/admin/schools/${encodeURIComponent(schoolId)}/flagged`);
  return flagged;
}

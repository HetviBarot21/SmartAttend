/**
 * Thin fetch wrappers over server/src/routes/admin.js - the cross-class,
 * cross-teacher reporting a school-admin session reads. Used only by
 * components/AdminOverview.jsx and AdminClassDetail.jsx; a teacher session
 * never calls these.
 *
 * Unlike the rest of the client, this data does NOT live in Dexie - the whole
 * point of the admin view is to see what every teacher's device has pushed to
 * the server, so it is fetched live (same-origin, via the Vite dev proxy /
 * production same-origin deploy, exactly like services/syncService.js's POST
 * /api/sync). A failed fetch (offline) surfaces as a thrown error the calling
 * component turns into an empty state - there is no offline admin view yet.
 */

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

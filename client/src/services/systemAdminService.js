/** Fetch wrappers for server/src/routes/systemAdmin.js. */

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json();
}

export async function getAllSchools() {
  const { schools } = await getJson('/api/system-admin/schools');
  return schools;
}

export async function setSchoolStatus(schoolId, status) {
  const res = await fetch(`/api/system-admin/schools/${encodeURIComponent(schoolId)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`status update responded ${res.status}`);
  return res.json();
}

import { useEffect, useMemo, useState } from 'react';
import { getStudentsByClass, getClassHistory, getFollowUpSummary } from '../db/database';
import { computeFeatures, scoreRiskML, isAssessable, toISO } from '../lib/riskModel';

const HISTORY_DAYS = 63; // covers the 6-week trend and the feature windows

function daysAgoISO(n) {
  const dt = new Date();
  dt.setDate(dt.getDate() - n);
  return toISO(dt);
}

/**
 * Roster, recent history and ML risk for one class.
 * `flagged` holds the amber/red students, highest risk first.
 */
export function useClassRisk(classGroupId) {
  const [students, setStudents] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [followUp, setFollowUp] = useState({ lastAt: new Map(), needsFollowUp: new Set() });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [roll, rows] = await Promise.all([
        getStudentsByClass(classGroupId),
        getClassHistory(classGroupId, daysAgoISO(HISTORY_DAYS)),
      ]);
      if (cancelled) return;
      setStudents(roll);
      setHistory(rows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [classGroupId]);

  const assessed = useMemo(() => {
    const asOf = toISO(new Date());
    const byStudent = new Map();
    for (const r of history) {
      if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
      byStudent.get(r.studentId).push({ date: r.date, status: r.status });
    }
    return students.map((student) => {
      const rows = byStudent.get(student.studentId) ?? [];
      return {
        student,
        rows,
        features: computeFeatures(rows, asOf),
        risk: scoreRiskML(rows, asOf),
        assessable: isAssessable(rows),
      };
    });
  }, [students, history]);

  const flagged = useMemo(
    () => assessed
      .filter((r) => r.assessable && r.risk.flag !== 'green')
      .sort((a, b) => b.risk.score - a.risk.score),
    [assessed],
  );

  useEffect(() => {
    let cancelled = false;
    getFollowUpSummary(flagged.map((f) => f.student.studentId)).then((summary) => {
      if (!cancelled) setFollowUp(summary);
    });
    return () => { cancelled = true; };
  }, [flagged]);

  return { loading, students, history, assessed, flagged, followUp };
}

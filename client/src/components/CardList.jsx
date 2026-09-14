import TopBar from './TopBar';

/**
 * Printable RFID card list: student name, admission number and the issued card
 * number, one row each. The teacher prints this and the numbers are encoded /
 * printed onto the physical cards. Everything outside `.cardlist-sheet` is
 * hidden by the print stylesheet.
 */
export default function CardList({ students, className, onClose }) {
  const rows = [...students].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const issued = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="app">
      <div className="no-print">
        <TopBar title="RFID Card List" onBack={onClose} />
      </div>

      <div className="app__scroll">
        <p className="card__hint no-print" style={{ marginTop: 4 }}>
          Print this and encode each number onto the student’s card. Reissue a
          number from the roster if a card is lost.
        </p>
        <button
          type="button"
          className="btn no-print"
          onClick={() => window.print()}
          style={{ marginBottom: 14 }}
        >
          Print
        </button>

        <div className="cardlist-sheet">
          <div className="cardlist-sheet__head">
            <h1>{className} RFID cards</h1>
            <p>{rows.length} students · generated {issued}</p>
          </div>
          <table className="cardlist-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Student</th>
                <th>Admission no.</th>
                <th>Card number</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr key={s.studentId}>
                  <td>{i + 1}</td>
                  <td>{s.fullName}</td>
                  <td>{s.admissionNo || '—'}</td>
                  <td className="cardlist-table__uid">{s.cardUid || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div aria-hidden="true" style={{ height: 24 }} />
        <button type="button" className="btn btn--ghost no-print" onClick={onClose}>Done</button>
        <div aria-hidden="true" style={{ height: 24 }} />
      </div>
    </div>
  );
}

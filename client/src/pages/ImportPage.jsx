import { useState } from 'react';
import { uploadPowerSchoolCSV } from '../services/api.js';

export default function ImportPage() {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(e) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setResult(null);
    try {
      const data = await uploadPowerSchoolCSV(file);
      setResult(data);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <h2 className="page-title">Import PowerSchool CSV</h2>
      <p className="subtitle">
        Upload a cleaned PowerSchool CSV to import or update student records.
        Existing students will be matched by name or PowerSchool ID and updated.
      </p>

      <div className="card">
        <form onSubmit={handleUpload} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '400px' }}>
          <input
            type="file"
            accept=".csv"
            onChange={e => setFile(e.target.files[0])}
          />
          <button className="primary" type="submit" disabled={!file || uploading}>
            {uploading ? 'Uploading...' : 'Upload & Import'}
          </button>
        </form>

        {result && (
          <div style={{ marginTop: '1rem' }}>
            {result.error ? (
              <p className="error-msg">{result.error}</p>
            ) : (
              <div>
                <p className="text-sm"><strong>Total rows:</strong> {result.total}</p>
                <p className="text-sm"><strong>Imported/updated:</strong> {result.imported}</p>
                <p className="text-sm"><strong>Skipped:</strong> {result.skipped}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>Expected CSV Columns</h3>
        <p className="text-sm text-muted">
          The importer is flexible with column names. These patterns are recognized:
        </p>
        <table style={{ marginTop: '0.5rem' }}>
          <thead>
            <tr><th>Field</th><th>Accepted Column Names</th></tr>
          </thead>
          <tbody>
            <tr><td>First Name</td><td className="text-sm">First Name, first_name, FirstName, Student First Name</td></tr>
            <tr><td>Last Name</td><td className="text-sm">Last Name, last_name, LastName, Student Last Name</td></tr>
            <tr><td>Email</td><td className="text-sm">Email, email, Student Email, Email Address</td></tr>
            <tr><td>Student ID</td><td className="text-sm">Student ID, student_id, PowerSchool ID, ID</td></tr>
            <tr><td>Parent Email</td><td className="text-sm">Parent Email, parent_email, Guardian Email</td></tr>
            <tr><td>Parent Phone</td><td className="text-sm">Parent Phone, parent_phone, Guardian Phone</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
